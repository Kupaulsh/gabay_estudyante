// Builds the web files into www/ (what Capacitor packages into the Android app,
// and what the GitHub Pages workflow publishes).
// Run with:  npm run build      (npm run sync also runs this first)
//
// With esbuild installed (npm install) the scripts are joined into ONE minified file
// and the stylesheet is minified too, so the app downloads and starts faster.
// Without it, the files are simply copied.
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, 'www');
fs.rmSync(out, {recursive: true, force: true});
fs.mkdirSync(out, {recursive: true});

let esbuild = null;
try{ esbuild = require('esbuild'); }catch(e){ console.warn('esbuild not found - copying files without minifying (run npm install).'); }

const SCRIPTS = ['vendor-supabase.js','supabase-client.js','data.js','study.js','app.js','notifications.js','admin.js'];
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const write = (f, c) => fs.writeFileSync(path.join(out, f), c);

let html = read('index.html');
let sw = read('sw.js');
const shell = ['./', 'index.html'];

if(esbuild){
  // Our own code is minified; the Supabase library is already minified, so it is only appended.
  const own = SCRIPTS.filter(f => f !== 'vendor-supabase.js').map(read).join('\n;\n');
  const minOwn = esbuild.transformSync(own, {minify: true, target: 'es2019', legalComments: 'none'}).code;
  const bundle = read('vendor-supabase.js') + '\n;\n' + minOwn;
  const hash = require('crypto').createHash('md5').update(bundle).digest('hex').slice(0, 8);
  const jsName = `app.${hash}.js`;
  write(jsName, bundle);

  const css = esbuild.transformSync(read('style.css'), {loader: 'css', minify: true}).code;
  const cssHash = require('crypto').createHash('md5').update(css).digest('hex').slice(0, 8);
  const cssName = `style.${cssHash}.css`;
  write(cssName, css);

  html = html.replace(/<script src="[^"]+"><\/script>\s*/g, '');
  html = html.replace('</body>', `<script src="${jsName}" defer></script>\n</body>`);
  html = html.replace('href="style.css"', `href="${cssName}"`);
  html = html.replace(/>\s+</g, '><');            // tidy the whitespace between tags
  shell.push(jsName, cssName);
  console.log(`Bundled scripts -> ${jsName} (${(bundle.length/1024).toFixed(0)} KB), css -> ${cssName} (${(css.length/1024).toFixed(0)} KB)`);
}else{
  SCRIPTS.concat(['style.css']).forEach(f => { fs.copyFileSync(path.join(__dirname, f), path.join(out, f)); shell.push(f); });
  html = html.replace(/<script src="([^"]+)"><\/script>/g, '<script src="$1" defer></script>');
}
write('index.html', html);

const images = fs.readdirSync(__dirname).filter(f => /\.(png|jpe?g|svg|webp|ico)$/i.test(f));
images.forEach(f => { fs.copyFileSync(path.join(__dirname, f), path.join(out, f)); shell.push(f); });

// tell the service worker which files to keep (a new bundle name also refreshes the cache)
const tag = require('crypto').createHash('md5').update(shell.join('|') + html).digest('hex').slice(0, 6);
sw = sw.replace(/const VERSION = '[^']*';/, `const VERSION = 'b${tag}';`)
       .replace(/\/\*SHELL\*\/[\s\S]*?\/\*END\*\//, `const SHELL = ${JSON.stringify(shell)};`);
write('sw.js', sw);
console.log(`Built ${shell.length + 1} files into www/`);
