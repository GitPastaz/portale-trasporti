// ============================================================
//  INTERMEDIARIO — legge i trasporti da HubSpot
//  Gira lato server su Vercel. Custodisce la chiave HubSpot
//  (mai esposta al browser) e restituisce al portale una
//  lista pulita di trasporti pronti per la mappa.
// ============================================================

// --- Configurazione: punto di partenza (sede) ---
// Le coordinate vengono ricavate geolocalizzando l'indirizzo (vedi sotto).
// I valori qui sono un fallback se il geocoding non risponde.
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
  note: "note_trasporto",
  // Coordinate salvate (per non richiamare Nominatim ogni volta)
  lat: "latitudine",
  lng: "longitudine",
  geoAddr: "indirizzo_geocodificato", // impronta dell'indirizzo geocodificato
};

// Fasi (dealstage) del Conto Esposizione in cui il trasporto e' gia'
// avvenuto o la trattativa e' chiusa/persa: vanno escluse da "Da organizzare"
// (sono lo storico pre-portale). La pipeline Vendita non ha intrusi.
const FASI_CE_ESCLUSE = [
  "3295795415", "5172594909", "5172594910", "4168541370", "5172594911",
  "4168541371", "1517507814", "1491411157", "5427280106", "1491411158",
  "5583540423", "4858382557", "2259898613", "2152219896", "1491589319",
  "5634262221", "1910224069",
];

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

// Impronta dell'indirizzo: stringa normalizzata usata per capire se
// l'indirizzo e' cambiato rispetto a quando furono salvate le coordinate.
function improntaIndirizzo(t) {
  return [t.indirizzo, t.cap, t.citta, t.prov]
    .map((x) => String(x || "").trim().toLowerCase())
    .join("|");
}

// Salva coordinate + impronta indirizzo sulla trattativa HubSpot (PATCH).
// Non blocca il flusso: se fallisce, semplicemente non salva (riprovera').
async function salvaCoordinate(id, lat, lng, impronta, token) {
  try {
    await hs("/crm/v3/objects/deals/" + id, token, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          latitudine: String(lat),
          longitudine: String(lng),
          indirizzo_geocodificato: impronta,
        },
      }),
    });
  } catch (e) {}
}

// Geocoding di una singola query.
// Restituisce {lat,lng} se trovato, null se NON trovato,
// oppure {errore:true} se il servizio non ha risposto (timeout/rete):
// distinzione essenziale per non marcare come "errato" un indirizzo valido
// quando Nominatim e' solo momentaneamente non disponibile.
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
    if (!r.ok) return { errore: true }; // servizio non disponibile ora
    const data = await r.json();
    if (data && data.length) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
    return null; // risposta valida ma indirizzo non trovato
  } catch (e) {
    return { errore: true }; // timeout o errore di rete
  }
}

// Geocoding "a cascata": prova dal piu' preciso al piu' approssimativo.
// Restituisce { lat, lng, precisione } se trovato,
//   { errore:true } se il servizio non ha risposto (non marcare come errato),
//   null se davvero non trovato.
async function geocodeCascata(t) {
  const via = (t.indirizzo || "").trim();
  const citta = (t.citta || "").trim();
  const cap = (t.cap || "").trim();
  const prov = (t.prov || "").trim();
  let servizioKO = false;

  const prova = async (q, precisione) => {
    const r = await geocodeRaw(q);
    if (r && r.errore) { servizioKO = true; return null; }
    if (r) return { ...r, precisione };
    return null;
  };

  // Livello 1: indirizzo completo (via + cap + citta + prov)
  if (via && (citta || cap)) {
    const r1 = await prova([via, cap, citta, prov].filter(Boolean).join(", "), "preciso");
    if (r1) return r1;
    // Livello 2: via + citta (senza cap)
    if (via && citta) {
      const r2 = await prova([via, citta, prov].filter(Boolean).join(", "), "preciso");
      if (r2) return r2;
    }
  }
  // Livello 3: citta + cap (approssimativo)
  if (citta || cap) {
    const r3 = await prova([cap, citta, prov].filter(Boolean).join(", "), "approssimativo");
    if (r3) return r3;
  }
  // Livello 4: solo citta'
  if (citta) {
    const r4 = await prova([citta, prov].filter(Boolean).join(", "), "approssimativo");
    if (r4) return r4;
  }

  // se almeno una chiamata e' fallita per il servizio, segnalo errore
  // (non "non trovato"), cosi' non marchiamo un indirizzo valido come errato
  if (servizioKO) return { errore: true };
  return null;
}

// Calcola la lista di anomalie (avvisi) per un trasporto.
function calcolaAnomalie(t) {
  const a = [];
  const dove = t.tipo === "ritiro" ? "di ritiro" : "di consegna";
  if (!t.autista) a.push("Autista non impostato");
  if (!t.veicolo) a.push("Veicolo non selezionato");
  if (!t.indirizzo) a.push("Indirizzo " + dove + " mancante: inserirlo su HubSpot");
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
    // Geolocalizzo subito l'indirizzo della sede, cosi' sia il pin sia il
    // calcolo delle distanze partono dal punto esatto. Fallback su ORIGINE.
    const origineOut = { ...ORIGINE };
    try {
      const posSede = await geocodeRaw(ORIGINE.indirizzo);
      if (posSede) { origineOut.lat = posSede.lat; origineOut.lng = posSede.lng; }
    } catch (e) {}

    // Timestamp di inizio giornata di oggi (mezzanotte ora italiana).
    // HubSpot confronta le date in millisecondi UTC.
    const oggi = new Date();
    oggi.setHours(0, 0, 0, 0);
    const oggiMs = oggi.getTime();

    const propsList = Object.values(F).concat(["dealname", "pipeline", "dealstage"]);

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
    const [dealsVendita, dealsRitiro, dealsVenditaNoData, dealsRitiroNoData] = await Promise.all([
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
      // "Da organizzare": a nostro carico, SENZA data, ma con indirizzo compilato
      scarica([
        { propertyName: "pipeline", operator: "EQ", value: PIPELINE.VENDITA },
        { propertyName: F.modalitaConsegna, operator: "EQ", value: "Consegna a nostro Carico" },
        { propertyName: F.dataConsegna, operator: "NOT_HAS_PROPERTY" },
        { propertyName: F.indirizzoConsegna, operator: "HAS_PROPERTY" },
      ]),
      scarica([
        { propertyName: "pipeline", operator: "EQ", value: PIPELINE.CONTO_ESPOSIZIONE },
        { propertyName: F.modalitaRitiro, operator: "EQ", value: "Team Argento Factory Srl" },
        { propertyName: F.dataRitiro, operator: "NOT_HAS_PROPERTY" },
        { propertyName: F.indirizzoRitiro, operator: "HAS_PROPERTY" },
        { propertyName: "dealstage", operator: "NOT_IN", values: FASI_CE_ESCLUSE },
      ]),
    ]);

    // 2) Costruisco la lista trasporti dai due gruppi gia' filtrati
    const trasporti = [];
    // memorizzo le coordinate gia' salvate su HubSpot (per id trasporto),
    // cosi' nel geocoding posso evitare di richiamare Nominatim
    const salvate = {};
    const registraSalvate = (d) => {
      const p = d.properties || {};
      const lat = parseFloat(p[F.lat]);
      const lng = parseFloat(p[F.lng]);
      salvate[d.id] = {
        lat: isNaN(lat) ? null : lat,
        lng: isNaN(lng) ? null : lng,
        geoAddr: p[F.geoAddr] || "",
      };
    };
    for (const d of dealsVendita) {
      const p = d.properties || {};
      registraSalvate(d);
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
        note: p[F.note] || "",
        cliente: "", telefono: "", targa: "", marca: "", modello: "",
      });
    }
    for (const d of dealsRitiro) {
      const p = d.properties || {};
      registraSalvate(d);
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
        note: p[F.note] || "",
        cliente: "", telefono: "", targa: "", marca: "", modello: "",
      });
    }

    // "Da organizzare": trasporti a nostro carico senza data, con indirizzo.
    // Li aggiungo alla lista con un flag, cosi' passano per l'arricchimento
    // (contatto, moto, geocoding) e poi li separo prima di rispondere.
    for (const d of dealsVenditaNoData) {
      const p = d.properties || {};
      registraSalvate(d);
      trasporti.push({
        _daOrganizzare: true, tipo: "consegna", data: null,
        indirizzo: p[F.indirizzoConsegna], citta: p[F.cittaConsegna],
        cap: p[F.capConsegna], prov: siglaProvincia(p[F.provinciaConsegna]),
        id: d.id, titolo: p.dealname || "Trasporto",
        autista: AUTISTI[p[F.autista]] || p[F.autista] || "",
        veicolo: p[F.veicolo] || "", note: p[F.note] || "",
        cliente: "", telefono: "", targa: "", marca: "", modello: "",
      });
    }
    for (const d of dealsRitiroNoData) {
      const p = d.properties || {};
      registraSalvate(d);
      trasporti.push({
        _daOrganizzare: true, tipo: "ritiro", data: null,
        indirizzo: p[F.indirizzoRitiro], citta: p[F.cittaRitiro],
        cap: p[F.capRitiro], prov: siglaProvincia(p[F.provinciaRitiro]),
        id: d.id, titolo: p.dealname || "Trasporto",
        autista: AUTISTI[p[F.autista]] || p[F.autista] || "",
        veicolo: p[F.veicolo] || "", note: p[F.note] || "",
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

    // 4) Coordinate + anomalie su ogni trasporto.
    // Strategia: se le coordinate sono gia' salvate su HubSpot E l'indirizzo
    // non e' cambiato, le uso SENZA chiamare Nominatim (veloce e stabile).
    // Altrimenti calcolo, salvo su HubSpot, uso. Se Nominatim non risponde,
    // NON marco l'indirizzo come errato (protezione anti-falso-allarme).
    //
    // IMPORTANTE per la stabilita': per non far mai scadere il tempo di
    // risposta, ogni singola chiamata geocodifica al massimo MAX_NUOVI
    // indirizzi nuovi. Gli altri restano "in aggiornamento" e verranno
    // completati ai caricamenti successivi (quando i primi sono gia' salvati
    // e quindi non pesano piu'). In pochi refresh tutti hanno le coordinate.
    const GEO_BUDGET = 15000;   // tetto di tempo prudente
    const MAX_NUOVI = 8;        // max indirizzi nuovi geocodificati per chiamata
    const startGeo = Date.now();
    let contatoreNuovi = 0;
    await Promise.all(trasporti.map(async (t) => {
      t.anomalie = calcolaAnomalie(t);

      // se non c'e' nessun dato di luogo, non si puo' geolocalizzare
      if (!t.indirizzo && !t.citta && !t.cap) {
        t.geo = "assente";
        return;
      }

      const impronta = improntaIndirizzo(t);
      const sal = salvate[t.id];

      // CASO A: coordinate gia' salvate e indirizzo invariato -> le uso
      if (sal && sal.lat != null && sal.lng != null && sal.geoAddr && sal.geoAddr === impronta) {
        t.lat = sal.lat;
        t.lng = sal.lng;
        t.geo = "preciso";
        t.km_showroom = kmAria(origineOut.lat, origineOut.lng, sal.lat, sal.lng);
        return;
      }

      // CASO B: coordinate mancanti o indirizzo cambiato -> ricalcolo.
      const mioTurno = contatoreNuovi++;

      // se ho gia' raggiunto il tetto di geocoding per questa chiamata,
      // uso le coordinate vecchie se ci sono, altrimenti rimando al refresh
      if (mioTurno >= MAX_NUOVI || Date.now() - startGeo > GEO_BUDGET) {
        if (sal && sal.lat != null && sal.lng != null) {
          t.lat = sal.lat; t.lng = sal.lng; t.geo = "preciso";
          t.km_showroom = kmAria(origineOut.lat, origineOut.lng, sal.lat, sal.lng);
        } else {
          t.geo = "non_processato"; // verra' completato al prossimo caricamento
        }
        return;
      }

      // sfaso le chiamate reali a Nominatim per rispettarne i limiti
      await new Promise((r) => setTimeout(r, mioTurno * 250));

      const pos = await geocodeCascata(t);

      if (pos && pos.errore) {
        // Nominatim non ha risposto: NON e' un errore dell'indirizzo.
        // Se ho coordinate vecchie salvate, le uso; altrimenti segnalo
        // "in aggiornamento" senza gridare all'errore.
        if (sal && sal.lat != null && sal.lng != null) {
          t.lat = sal.lat; t.lng = sal.lng; t.geo = "preciso";
          t.km_showroom = kmAria(origineOut.lat, origineOut.lng, sal.lat, sal.lng);
        } else {
          t.geo = "non_processato";
        }
        return;
      }

      if (pos) {
        t.lat = pos.lat;
        t.lng = pos.lng;
        t.geo = pos.precisione;
        t.km_showroom = kmAria(origineOut.lat, origineOut.lng, pos.lat, pos.lng);
        if (pos.precisione === "approssimativo") {
          t.anomalie.push("Posizione approssimativa: verificare indirizzo");
        }
        // salvo le coordinate su HubSpot per le prossime volte (non blocca)
        salvaCoordinate(t.id, pos.lat, pos.lng, impronta, TOKEN);
      } else {
        // risposta valida ma indirizzo non riconosciuto: da verificare
        t.geo = "non_trovato";
        t.anomalie.push("Indirizzo non riconosciuto: verificare su HubSpot");
      }
    }));

    // Separo i due gruppi: datati (trasporti) e senza data (da_organizzare)
    const datati = trasporti.filter((t) => !t._daOrganizzare);
    const daOrganizzare = trasporti.filter((t) => t._daOrganizzare);

    // riepilogo anomalie per il contatore in cima al portale (solo datati)
    const conAnomalie = datati.filter((t) => t.anomalie && t.anomalie.length).length;

    // Cache breve lato CDN (30s) per assorbire clic ravvicinati di piu'
    // utenti, ma il browser non deve mai servire una copia vecchia: cosi'
    // "Aggiorna" mostra sempre lo stato reale di HubSpot.
    res.setHeader("Cache-Control", "no-store, max-age=0, s-maxage=30");
    return res.status(200).json({
      origine: origineOut,
      trasporti: datati,
      da_organizzare: daOrganizzare,
      riepilogo: {
        totale: datati.length,
        con_anomalie: conAnomalie,
        da_organizzare: daOrganizzare.length,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
