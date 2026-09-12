// Shared admin-table renderer. Used by the app route (/admin/lists/:name/:period)
// and by build-admin.mjs. Embeds rows as JSON; filter/sort/search client-side.

export function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"' && text[i+1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c === '\r') {}
    else cell += c; }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const hdr = rows.shift();
  return rows.filter(r => r.some(x => x && x.trim())).map(r => Object.fromEntries(hdr.map((h, i) => [h, r[i] ?? ''])));
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// rows: array of objects. opts: { title, subtitle, csvHref, listsHref }
export function renderAdminHTML(rows, opts = {}) {
  const title = opts.title || 'Lead Admin';
  const json = JSON.stringify(rows).replace(/</g, '\\u003c');
  const crumb = (opts.listsHref ? `<a href="${esc(opts.listsHref)}">lists</a> / ` : '') + esc(opts.subtitle || '');
  const dl = opts.csvHref ? `<a class="dl" href="${esc(opts.csvHref)}">↓ CSV</a>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--line:#e4e4e0;--tx:#1a1a18;--mut:#77776f;--accent:#2f6f4f;
--A:#1f8a4c;--B:#3b7ddd;--C:#b8860b;--D:#9a9a92;--yes:#1f8a4c;--maybe:#c07a12;--no:#b0b0a8;}
@media(prefers-color-scheme:dark){:root{--bg:#17170f;--card:#22221c;--line:#33332a;--tx:#ececdf;--mut:#9a9a8c;}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.4 system-ui,Segoe UI,Roboto,sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);padding:10px 14px}
h1{font-size:15px;margin:0 0 3px}.crumb{font-size:12px;color:var(--mut);margin-bottom:8px}
.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input[type=search]{flex:1;min-width:200px;padding:7px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--tx)}
.chip{cursor:pointer;user-select:none;padding:4px 10px;border:1px solid var(--line);border-radius:999px;background:var(--bg);font-size:12px;color:var(--mut)}
.chip.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.count{font-size:12px;color:var(--mut);margin-left:auto}
.dl{font-size:12px;color:var(--accent);text-decoration:none;border:1px solid var(--line);padding:4px 9px;border-radius:7px}
.wrap{overflow-x:auto;padding:0 6px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top;white-space:nowrap}
th{position:sticky;top:0;background:var(--card);cursor:pointer;font-weight:600;font-size:12px;color:var(--mut)}
th:hover{color:var(--tx)}td.wrapc{white-space:normal;max-width:320px}
tr:hover td{background:rgba(127,127,110,.06)}
.badge{display:inline-block;padding:1px 7px;border-radius:5px;font-size:11px;font-weight:700;color:#fff}
.gA{background:var(--A)}.gB{background:var(--B)}.gC{background:var(--C)}.gD{background:var(--D)}
.iy{color:var(--yes);font-weight:600}.im{color:var(--maybe);font-weight:600}.ino{color:var(--no)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.cp{cursor:pointer}.cp:hover{text-decoration:underline}
.ls{font-size:11px;padding:1px 6px;border:1px solid var(--line);border-radius:5px;color:var(--mut)}
small{color:var(--mut)}
</style></head><body>
<header>
<h1>${esc(title)} <small id="src"></small></h1>
<div class="crumb">${crumb}</div>
<div class="controls">
  <input type="search" id="q" placeholder="Search name, email, company, domain, signals…">
  <span id="grades"></span><span id="indias"></span><span id="links"></span>
  ${dl}<span class="count" id="count"></span>
</div></header>
<div class="wrap"><table><thead><tr id="head"></tr></thead><tbody id="body"></tbody></table></div>
<script>
const DATA=${json};
const has=k=>DATA.some(r=>k in r && r[k]!=="");
const COLS=[["grade","Grade"],["india","India"],["link_status","Link"],["name","Name"],["primary_email","Email"],
["email_tier","Tier"],["verified_linkedin","LI?"],["linkedin_profile","LinkedIn"],["topmate_profile","Topmate"],
["website","Website"],["company","Company"],["domain","Domain"],["ascore","DA"],["india_signals","Signals"],["discovered_phones","Phone"]]
.filter(([k])=>k==="name"||has(k));
const name=r=>r.name||r.tm_name||"";
let filt={grade:new Set(),india:new Set(),link:new Set()},q="",sortK="",sortDir=1;
const el=id=>document.getElementById(id);
el("src").textContent="· "+DATA.length+" leads";
function chips(host,key,vals){if(!has(key)){el(host).remove?0:0;return}for(const v of vals){const c=document.createElement("span");c.className="chip";c.textContent=v;
 c.onclick=()=>{filt[key].has(v)?filt[key].delete(v):filt[key].add(v);c.classList.toggle("on");render()};el(host).appendChild(c)}}
chips("grades","grade",["A","B","C","D"]);chips("indias","india",["yes","maybe","no"]);chips("links","link_status",["active","new","lost"]);
el("q").oninput=e=>{q=e.target.value.toLowerCase();render()};
el("head").innerHTML=COLS.map(([k,l])=>'<th data-k="'+k+'">'+l+'</th>').join("");
document.querySelectorAll("th").forEach(th=>th.onclick=()=>{const k=th.dataset.k;sortDir=(sortK===k)?-sortDir:1;sortK=k;render()});
const A=(u,t)=>u?'<a href="'+u+'" target="_blank" rel="noopener">'+(t||u.replace(/^https?:\\/\\/(www\\.)?/,"").slice(0,32))+'</a>':"";
function render(){
 let rows=DATA.filter(r=>{
  if(filt.grade.size&&!filt.grade.has(r.grade))return false;
  if(filt.india.size&&!filt.india.has(r.india))return false;
  if(filt.link.size&&!filt.link.has(r.link_status))return false;
  if(q){const blob=(name(r)+" "+r.primary_email+" "+r.company+" "+r.domain+" "+r.india_signals+" "+r.topmate_profile).toLowerCase();if(!blob.includes(q))return false;}
  return true;});
 if(sortK){const iR={yes:0,maybe:1,no:2},gR={A:0,B:1,C:2,D:3};
  rows.sort((a,b)=>{let x=a[sortK]||"",y=b[sortK]||"";
   if(sortK==="ascore"){x=+x||0;y=+y||0}else if(sortK==="india"){x=iR[x]??3;y=iR[y]??3}else if(sortK==="grade"){x=gR[x]??9;y=gR[y]??9}
   else{x=(""+x).toLowerCase();y=(""+y).toLowerCase()}
   return (x<y?-1:x>y?1:0)*sortDir});}
 el("count").textContent=rows.length+" shown";
 el("body").innerHTML=rows.map(r=>{
  const em=r.primary_email?'<span class="cp" title="copy" onclick="navigator.clipboard.writeText(\\''+r.primary_email+'\\')">'+r.primary_email+'</span>':'<small>—</small>';
  const lislug=((r.linkedin_profile||"").match(/\\/in\\/([^/?#]+)/)||[])[1];
  const li=r.linkedin_profile?A(r.linkedin_profile,lislug?"in/"+lislug.slice(0,20):"linkedin"):"";
  const tm=r.topmate_profile?A(r.topmate_profile,r.topmate_profile.replace("https://topmate.io/","")):"";
  const iv=r.verified_linkedin||"";const ok=/confirm|corrected|topmate_only/.test(iv)?"✓":"";
  const cell={grade:'<span class="badge g'+r.grade+'">'+r.grade+'</span>',
   india:'<span class="'+(r.india==="yes"?"iy":r.india==="maybe"?"im":"ino")+'">'+(r.india||"")+'</span>',
   link_status:'<span class="ls">'+(r.link_status||"")+'</span>',name:(name(r)||"<small>—</small>"),
   primary_email:em,email_tier:'<small>'+(r.email_tier||"")+'</small>',verified_linkedin:'<span title="'+iv+'">'+ok+'</span>',
   linkedin_profile:li,topmate_profile:tm,website:A(r.website),company:(r.company||"").slice(0,28),
   domain:r.domain||"",ascore:r.ascore||"",india_signals:'<small>'+(r.india_signals||"").replace(/\\|/g," · ")+'</small>',
   discovered_phones:'<small>'+(r.discovered_phones||"").slice(0,24)+'</small>'};
  return '<tr>'+COLS.map(([k])=>'<td'+(k==="india_signals"?' class="wrapc"':'')+'>'+(cell[k]??(r[k]||""))+'</td>').join("")+'</tr>';
 }).join("");
}
render();
</script></body></html>`;
}
