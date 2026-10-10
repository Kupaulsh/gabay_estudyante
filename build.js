// Copies the web files into www/ (what Capacitor packages into the Android app).
// Run with:  npm run build      (npm run sync also runs this first)
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, 'www');
fs.mkdirSync(out, {recursive: true});

const files = ['index.html','style.css','app.js','admin.js','data.js','notifications.js',
  'supabase-client.js','vendor-supabase.js','sw.js'];
fs.readdirSync(__dirname).forEach(f=>{ if(/\.(png|jpe?g|svg|webp|ico)$/i.test(f)) files.push(f); });

let n = 0;
files.forEach(f=>{
  const src = path.join(__dirname, f);
  if(fs.existsSync(src)){ fs.copyFileSync(src, path.join(out, f)); n++; }
  else console.warn('Missing (skipped): ' + f);
});
console.log(`Copied ${n} files to www/`);
