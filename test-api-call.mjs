// test-api-call.mjs — Run on server: node /var/www/vetpower/test-api-call.mjs
const res = await fetch('http://localhost:3001/api/classify', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'vp-api-d40-2026-secure',
  },
  body: JSON.stringify({
    session: {
      sessionId: 'test1',
      animalType: 'Dairy Cow',
      conversation: 'Farmer: My cow has diarrhea for 3 days and is not eating well. AI: I recommend ORS and Albendazole dewormer. Contact a vet for Alamycin LA.',
    },
  }),
});
const data = await res.json();
console.log('Status:', res.status);
console.log(JSON.stringify(data, null, 2));
