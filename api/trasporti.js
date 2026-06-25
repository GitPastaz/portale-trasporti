// ============================================================
//  INTERMEDIARIO — legge i trasporti da HubSpot
//  Gira lato server su Vercel. Custodisce la chiave HubSpot
//  (mai esposta al browser) e restituisce al portale una
//  lista pulita di trasporti pronti per la mappa.
// ============================================================

// --- Configurazione: punto di partenza (sede) ---
const ORIGINE = {
  nome: "Showroom Cesano Maderno",
  indirizzo: "Via Nazionale dei Giovi 28, 20811 Cesano Maderno MB",
  lat: 45.6260,
  lng: 9.1730,
};

// --- Traduzione valori tendine: value salvato -> label leggibile ---
const AUTISTI = {
  "Giuseppe": "Giuseppe Soldi",
  "Matteo Zagni": "Matteo Zagni",
};

// ID interni delle pipeline su HubSpot. Il tipo di trattativa
// (consegna / ritiro) si ricava dalla pipeline, non da un campo.
const PIPELINE = {
  VENDITA: "739737831",         // -> consegna
  CONTO_ESPOSIZIONE: "1074000091", // -> ritiro
};

// Gli slug reali dei campi su HubSpot (dalla tabella di traduzione)
const F = {
  // Consegna
  dataConsegna: "data_consegna",
  modalitaConsegna: "modalita_di_consegna",
  indirizzoConsegna: "luogo_di_consegna",
  cittaConsegna: "citta_di_consegna",
  capConsegna: "cap_di_consegna",
  provinciaConsegna: "provincia_di_consegna",
  // Ritiro
  dataRitiro: "data_e_ora_di_ritiro_acquisizione_moto",
  modalitaRitiro: "ritiro_acquisizione_a_carico_di_",
  indirizzoRitiro: "luogo_del_ritiro",
  cittaRitiro: "citta_di_ritiro",
  capRitiro: "cap_di_ritiro",
  provinciaRitiro: "provincia_di_ritiro",
  // Comuni
  veicolo: "veicolo_del_trasporto",
  autista: "autista_del_trasporto",
  costo: "costo_trasporto",
  note: "note_trasporto",
};

// Endpoint HubSpot. Gli account europei (token pat-eu1-...) devono usare
// api-eu1.hubapi.com, altrimenti la richiesta arriva al data center USA
// e risponde 401 ("hublet mismatch"). Si puo' sovrascrivere con la
// variabile d'ambiente HUBSPOT_API_BASE se l'account cambia regione.
const HS = process.env.HUBSPOT_API_BASE || "https://api-eu1.hubapi.com";

// Estrae la sigla provincia ("MB Monza e Brianza" -> "MB")
function siglaProvincia(v) {
  if (!v) return "";
  const m = String(v).match(/^([A-Z]{2})\b/);
  return m ? m[1] : v;
}

// Geocoding gratuito via Nominatim (OpenStreetMap)
// Distanza approssimata in km (linea d'aria, Haversine) tra due punti.
// La distanza su strada reale verra' aggiunta con un servizio di routing.
function kmAria(lat1, lng1, lat2, lng2) {
  if (lat1 == null || lat2 == null) return null;
  const R = 6371, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

// Geocoding di una singola query. Restituisce {lat,lng} o null.
async function geocodeRaw(query) {
  if (!query) return null;
  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=it&q=" +
    encodeURIComponent(query);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(url, {
      headers: { "User-Agent": "PortaleTrasporti/1.0 (uso interno Moto Argento)" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const data = await r.json();
    if (data && data.length) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch (e) {}
  return null;
}

// Geocoding "a cascata": prova dal piu' preciso al piu' approssimativo.
// Restituisce { lat, lng, precisione } dove precisione e':
//   "preciso"        -> trovato con via + civico
//   "approssimativo" -> trovato solo con citta'/CAP (posizione indicativa)
//   null             -> non trovato affatto
async function geocodeCascata(t) {
  const via = (t.indirizzo || "").trim();
  const citta = (t.citta || "").trim();
  const cap = (t.cap || "").trim();
  const prov = (t.prov || "").trim();

  // Livello 1: indirizzo completo (via + cap + citta + prov)
  if (via && (citta || cap)) {
    const q1 = [via, cap, citta, prov].filter(Boolean).join(", ");
    const r1 = await geocodeRaw(q1);
    if (r1) return { ...r1, precisione: "preciso" };

    // Livello 2: via + citta (senza cap, a volte il cap confonde)
    if (via && citta) {
      const r2 = await geocodeRaw([via, citta, prov].filter(Boolean).join(", "));
      if (r2) return { ...r2, precisione: "preciso" };
    }
  }

  // Livello 3: citta + cap (posizione approssimativa, centro citta')
  if (citta || cap) {
    const r3 = await geocodeRaw([cap, citta, prov].filter(Boolean).join(", "));
    if (r3) return { ...r3, precisione: "approssimativo" };
  }

  // Livello 4: solo citta'
  if (citta) {
    const r4 = await geocodeRaw([citta, prov].filter(Boolean).join(", "));
    if (r4) return { ...r4, precisione: "approssimativo" };
  }

  return null;
}

// Calcola la lista di anomalie (avvisi) per un trasporto.
function calcolaAnomalie(t) {
  const a = [];
  if (!t.autista) a.push("Autista non impostato");
  if (!t.veicolo) a.push("Veicolo non selezionato");
  if (!t.indirizzo) a.push("Indirizzo mancante");
  if (!t.cap) a.push("CAP mancante");
  if (!t.prov) a.push("Provincia mancante");
  if (!t.citta) a.push("Citta' mancante");
  return a;
}

// Chiamata generica a HubSpot, con timeout per non restare appesi
async function hs(path, token, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let r;
  try {
    r = await fetch(HS + path, {
      ...options,
      signal: ctrl.signal,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) {
    const txt = await r.text();
    throw new Error("HubSpot " + r.status + ": " + txt.slice(0, 200));
  }
  return r.json();
}

module.exports = async (req, res) => {
  const TOKEN = process.env.HUBSPOT_TOKEN;
  if (!TOKEN) {
    return res.status(500).json({ error: "Chiave HubSpot non configurata" });
  }

  try {
    // Timestamp di inizio giornata di oggi (mezzanotte ora italiana).
    // HubSpot confronta le date in millisecondi UTC.
    const oggi = new Date();
    oggi.setHours(0, 0, 0, 0);
    const oggiMs = oggi.getTime();

    const propsList = Object.values(F).concat(["dealname", "pipeline"]);

    // Funzione che scarica le trattative di UNA ricerca, con paginazione
    async function scarica(filters) {
      let after = undefined;
      let out = [];
      let pagine = 0;
      do {
        const body = {
          filterGroups: [{ filters }],
          properties: propsList,
          limit: 100,
        };
        if (after) body.after = after;
        const page = await hs("/crm/v3/objects/deals/search", TOKEN, {
          method: "POST",
          body: JSON.stringify(body),
        });
        out = out.concat(page.results || []);
        after = page.paging && page.paging.next ? page.paging.next.after : undefined;
        pagine++;
      } while (after && pagine < 10);
      return out;
    }

    // 1) Due ricerche mirate, filtrate da HubSpot:
    //    a) CONSEGNE a nostro carico, con data di consegna da oggi in poi
    //    b) RITIRI a nostro carico, con data di ritiro da oggi in poi
    //    Cosi' dei ~2000 record HubSpot ne restituisce solo una manciata.
    const [dealsVendita, dealsRitiro] = await Promise.all([
      scarica([
        { propertyName: "pipeline", operator: "EQ", value: PIPELINE.VENDITA },
        { propertyName: F.modalitaConsegna, operator: "EQ", value: "Consegna a nostro Carico" },
        { propertyName: F.dataConsegna, operator: "GTE", value: String(oggiMs) },
      ]),
      scarica([
        { propertyName: "pipeline", operator: "EQ", value: PIPELINE.CONTO_ESPOSIZIONE },
        { propertyName: F.modalitaRitiro, operator: "EQ", value: "Team Argento Factory Srl" },
        { propertyName: F.dataRitiro, operator: "GTE", value: String(oggiMs) },
      ]),
    ]);

    // 2) Costruisco la lista trasporti dai due gruppi gia' filtrati
    const trasporti = [];
    for (const d of dealsVendita) {
      const p = d.properties || {};
      trasporti.push({
        tipo: "consegna",
        data: p[F.dataConsegna],
        indirizzo: p[F.indirizzoConsegna],
        citta: p[F.cittaConsegna],
        cap: p[F.capConsegna],
        prov: siglaProvincia(p[F.provinciaConsegna]),
        id: d.id,
        titolo: p.dealname || "Trasporto",
        autista: AUTISTI[p[F.autista]] || p[F.autista] || "",
        veicolo: p[F.veicolo] || "",
        costo: p[F.costo] || "",
        note: p[F.note] || "",
        cliente: "", telefono: "", targa: "", marca: "", modello: "",
      });
    }
    for (const d of dealsRitiro) {
      const p = d.properties || {};
      trasporti.push({
        tipo: "ritiro",
        data: p[F.dataRitiro],
        indirizzo: p[F.indirizzoRitiro],
        citta: p[F.cittaRitiro],
        cap: p[F.capRitiro],
        prov: siglaProvincia(p[F.provinciaRitiro]),
        id: d.id,
        titolo: p.dealname || "Trasporto",
        autista: AUTISTI[p[F.autista]] || p[F.autista] || "",
        veicolo: p[F.veicolo] || "",
        costo: p[F.costo] || "",
        note: p[F.note] || "",
        cliente: "", telefono: "", targa: "", marca: "", modello: "",
      });
    }

    // 3) Recupero contatto (nome+telefono) e prodotto (targa) associati.
    //    In parallelo per non sommare i tempi di attesa.
    await Promise.all(trasporti.map(async (t) => {
      try {
        const assoc = await hs(
          "/crm/v4/objects/deals/" + t.id + "/associations/contacts?limit=1",
          TOKEN
        );
        const cid = assoc.results && assoc.results[0] && assoc.results[0].toObjectId;
        if (cid) {
          const c = await hs(
            "/crm/v3/objects/contacts/" + cid + "?properties=firstname,lastname,phone",
            TOKEN
          );
          const cp = c.properties || {};
          t.cliente = [cp.firstname, cp.lastname].filter(Boolean).join(" ");
          t.telefono = cp.phone || "";
        }
      } catch (e) {}

      try {
        const assocL = await hs(
          "/crm/v4/objects/deals/" + t.id + "/associations/line_items?limit=1",
          TOKEN
        );
        const lid = assocL.results && assocL.results[0] && assocL.results[0].toObjectId;
        if (lid) {
          const li = await hs(
            "/crm/v3/objects/line_items/" + lid + "?properties=name,targa,marca,modello_moto",
            TOKEN
          );
          const lp = li.properties || {};
          t.targa = lp.targa || "";
          t.marca = lp.marca || "";
          t.modello = lp.modello_moto || "";
          if (!t.titolo || t.titolo === "Trasporto") t.titolo = lp.name || t.titolo;
        }
      } catch (e) {}
    }));

    // 4) Geocoding a cascata + calcolo anomalie su ogni trasporto.
    const GEO_BUDGET = 25000; // ms massimi dedicati al geocoding
    const startGeo = Date.now();
    await Promise.all(trasporti.map(async (t, i) => {
      // anomalie sui campi (indipendenti dal geocoding)
      t.anomalie = calcolaAnomalie(t);

      // se non c'e' nessun dato di luogo, non si puo' geolocalizzare
      if (!t.indirizzo && !t.citta && !t.cap) {
        t.geo = "assente";
        return;
      }

      await new Promise((r) => setTimeout(r, i * 200));
      if (Date.now() - startGeo > GEO_BUDGET) {
        t.geo = "non_processato"; // budget esaurito, riprovera' al refresh
        return;
      }

      const pos = await geocodeCascata(t);
      if (pos) {
        t.lat = pos.lat;
        t.lng = pos.lng;
        t.geo = pos.precisione; // "preciso" | "approssimativo"
        // distanza approssimata dallo Showroom Moto Argento (Cesano Maderno)
        t.km_showroom = kmAria(ORIGINE.lat, ORIGINE.lng, pos.lat, pos.lng);
        if (pos.precisione === "approssimativo") {
          t.anomalie.push("Posizione approssimativa: verificare indirizzo");
        }
      } else {
        t.geo = "non_trovato";
        t.anomalie.push("Indirizzo non localizzato: correggere su HubSpot");
      }
    }));

    // riepilogo anomalie per il contatore in cima al portale
    const conAnomalie = trasporti.filter((t) => t.anomalie && t.anomalie.length).length;

    // Cache breve lato CDN (30s) per assorbire clic ravvicinati di piu'
    // utenti, ma il browser non deve mai servire una copia vecchia: cosi'
    // "Aggiorna" mostra sempre lo stato reale di HubSpot.
    res.setHeader("Cache-Control", "no-store, max-age=0, s-maxage=30");
    return res.status(200).json({
      origine: ORIGINE,
      trasporti,
      riepilogo: { totale: trasporti.length, con_anomalie: conAnomalie },
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
