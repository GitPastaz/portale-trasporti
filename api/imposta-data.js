// ============================================================
//  IMPOSTA DATA — scrive la data/ora del trasporto su HubSpot
//  Gira lato server su Vercel. Custodisce la chiave HubSpot.
//  Scrive sul campo corretto in base al TIPO del trasporto:
//   - consegna (pipeline Vendita)      -> data_consegna
//   - ritiro   (pipeline Conto Espos.) -> data_e_ora_di_ritiro_acquisizione_moto
//  La data arriva dal portale come stringa ISO (dal selettore
//  data+ora del browser) e viene convertita nel formato HubSpot.
// ============================================================

const HS = "https://api-eu1.hubapi.com";

// Slug dei due campi data, per tipo di trasporto
const CAMPO_DATA = {
  consegna: "data_consegna",
  ritiro: "data_e_ora_di_ritiro_acquisizione_moto",
};

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
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metodo non consentito" });
  }

  const TOKEN = process.env.HUBSPOT_TOKEN;
  if (!TOKEN) {
    return res.status(500).json({ error: "Chiave HubSpot non configurata" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const id = body && body.id;
  const tipo = body && body.tipo;
  // millisecondi epoch (istante assoluto) gia' calcolati dal browser nel
  // fuso locale dell'utente. Stringa vuota = svuota il campo.
  const ms = body && body.ms;
  // valori interni delle tendine (undefined = non toccare il campo)
  const autista = body && body.autista;
  const veicolo = body && body.veicolo;

  // --- Validazioni ---
  if (!id) {
    return res.status(400).json({ error: "ID trasporto mancante" });
  }

  // Costruisco l'insieme delle proprieta' da aggiornare: includo solo
  // quelle effettivamente presenti nel body, cosi' lo stesso endpoint
  // serve per modificare data, autista, veicolo (singolarmente o insieme).
  const props = {};

  // Data: richiede il tipo per sapere su quale campo scrivere
  if (ms !== undefined) {
    if (tipo !== "consegna" && tipo !== "ritiro") {
      return res.status(400).json({ error: "Tipo trasporto non valido" });
    }
    let valore = null;
    if (ms !== "" && ms != null) {
      const n = Number(ms);
      if (!Number.isFinite(n)) {
        return res.status(400).json({ error: "Data non valida" });
      }
      valore = String(n);
    }
    props[CAMPO_DATA[tipo]] = valore;
  }

  // Autista e Veicolo: valore interno della tendina, o "" per svuotare
  if (autista !== undefined) props["autista_del_trasporto"] = autista || null;
  if (veicolo !== undefined) props["veicolo_del_trasporto"] = veicolo || null;

  if (Object.keys(props).length === 0) {
    return res.status(400).json({ error: "Nessun campo da aggiornare" });
  }

  try {
    await hs("/crm/v3/objects/deals/" + id, TOKEN, {
      method: "PATCH",
      body: JSON.stringify({ properties: props }),
    });
    return res.status(200).json({ ok: true, props });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
