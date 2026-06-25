# Portale Trasporti — Istruzioni di caricamento su Vercel

Questo pacchetto contiene tutto il portale. Sotto trovi i passaggi per
pubblicarlo, spiegati senza dare nulla per scontato.

## Cosa c'è dentro

- `public/index.html` → il portale che vede l'utente (login, mappa, lista, filtri)
- `api/trasporti.js` → l'intermediario che legge i dati da HubSpot (custodisce la chiave)
- `api/login.js` → la verifica della password d'accesso
- `vercel.json` → configurazione per Vercel

## I due valori segreti (NON sono scritti nei file)

Per sicurezza, due valori veri non sono nel codice. Li inserirai tu
direttamente su Vercel, come "variabili d'ambiente":

1. `HUBSPOT_TOKEN` → la chiave di servizio HubSpot
   (CONSIGLIO: rigenerala su HubSpot prima di usarla, dato che la
    precedente è passata per strumenti esterni)
2. `PORTAL_PASSWORD` → la password d'accesso al portale
   (scegline una NUOVA, diversa da quella scritta in chat)

## Come pubblicare (senza GitHub)

1. Installa Node.js sul tuo computer (se non ce l'hai):
   vai su nodejs.org e scarica la versione "LTS" per Windows.

2. Apri il "Prompt dei comandi" di Windows e installa lo strumento Vercel:
   npm install -g vercel

3. Entra nella cartella del progetto (quella che contiene questo file):
   cd percorso\della\cartella\portale-trasporti

4. Avvia il caricamento:
   vercel

   Ti chiederà di accedere (login con la mail dell'account Vercel) e
   farà alcune domande — accetta le risposte predefinite premendo Invio.

5. Imposta i due valori segreti:
   vercel env add HUBSPOT_TOKEN
   (incolla la chiave quando richiesto)
   vercel env add PORTAL_PASSWORD
   (scrivi la password quando richiesto)

   In alternativa puoi farlo dal sito di Vercel:
   Progetto → Settings → Environment Variables → Add.

6. Ripubblica perché le variabili abbiano effetto:
   vercel --prod

Alla fine Vercel ti darà un indirizzo tipo
https://portale-trasporti-xxxx.vercel.app
Aprilo: vedrai la schermata di login.

## Il dominio trasporti.motoargento.com

Lo colleghiamo dopo, insieme (Passo 6):
Vercel → Progetto → Settings → Domains → aggiungi trasporti.motoargento.com,
poi crei il record DNS indicato da Vercel dove gestisci il dominio.
