// Builds the served i18n.js bundle = dictionary + translator core.
const fs = require('fs');
const dict = fs.readFileSync('translations.json', 'utf8');
const core = fs.readFileSync('i18n-core.js', 'utf8');
fs.writeFileSync('i18n.js', 'window.__I18N_DICT__=' + dict + ';\n' + core);
console.log('built i18n.js (' + (fs.statSync('i18n.js').size / 1024).toFixed(0) + ' KB)');
