// ============================================================
//  LOGIN — verifica la password del portale
//  La password vera vive nelle variabili d'ambiente di Vercel
//  (PORTAL_PASSWORD), mai scritta nei file.
//  Progettato per ospitare più utenti in futuro: basta
//  estendere UTENTI o passare a un elenco di coppie.
// ============================================================

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metodo non consentito" });
  }

  const expected = process.env.PORTAL_PASSWORD;
  if (!expected) {
    return res.status(500).json({ error: "Password non configurata" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const password = (body && body.password) || "";

  // Confronto. In futuro: ciclo su un elenco di utenti/password.
  if (password && password === expected) {
    // token di sessione semplice (valido per il browser corrente)
    const token = Buffer.from("ok:" + Date.now()).toString("base64");
    res.setHeader(
      "Set-Cookie",
      "pt_auth=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200"
    );
    return res.status(200).json({ ok: true });
  }

  return res.status(401).json({ ok: false, error: "Password errata" });
};
