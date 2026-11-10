import type { Plan } from "./db";

const esc = (s: unknown) =>
	String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `
:root{--bg:#f6f7f5;--card:#fff;--text:#1b1f1d;--muted:#5d6762;--line:#dfe3e0;--accent:#1f9e80;--accent-ink:#fff;--new:#e3f6ee;--chg:#fff4d6;--err:#b42318;--err-bg:#fdecea}
@media (prefers-color-scheme:dark){:root{--bg:#121514;--card:#1b201e;--text:#e9eeeb;--muted:#9aa6a0;--line:#2c3431;--accent:#2ecda7;--accent-ink:#06261d;--new:#123326;--chg:#3a3112;--err:#ff8a80;--err-bg:#3b1715}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:0 0 12px}
.sub{color:var(--muted);margin:0 0 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:16px}
label{display:block;font-weight:600;margin-bottom:6px}
input[type=email],textarea,select{width:100%;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px}
textarea{min-height:64px;resize:vertical}
button{font:inherit;font-weight:600;border:0;border-radius:8px;padding:10px 16px;cursor:pointer;background:var(--accent);color:var(--accent-ink)}
button.secondary{background:transparent;color:var(--text);border:1px solid var(--line)}
button:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.drop{border:2px dashed var(--line);border-radius:12px;padding:28px 16px;text-align:center;color:var(--muted);cursor:pointer;margin-bottom:16px}
.drop.over{border-color:var(--accent);color:var(--text)}
.files{list-style:none;padding:0;margin:0 0 16px}
.files li{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)}
.files button{padding:2px 8px;background:transparent;color:var(--muted)}
.error{background:var(--err-bg);color:var(--err);border-radius:8px;padding:10px 12px;margin:12px 0}
.warn{background:var(--chg);border-radius:8px;padding:10px 12px;margin:8px 0}
.muted{color:var(--muted)}
.tablewrap{overflow-x:auto;margin:8px 0 4px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
td.num,th.num{text-align:right}
tr.create td{background:var(--new)}tr.update td{background:var(--chg)}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:99px;border:1px solid var(--line)}
.spinner{display:inline-block;width:16px;height:16px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;vertical-align:-3px;margin-right:8px}
@keyframes spin{to{transform:rotate(360deg)}}
[hidden]{display:none!important}
`;

/** Shared renderer for a plan, used both in the portal (client-side) and the review page (server-side). */
const RENDER_PLAN_JS = `
function fmt(n){return n===null||n===undefined?'–':Number(n).toLocaleString('de-DE')}
function escH(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c])}
function renderPlan(plan){
  let h='<p>'+escH(plan.summary)+'</p>';
  for(const w of plan.warnings||[]) h+='<div class="warn">⚠︎ '+escH(w)+'</div>';
  for(const t of plan.tables){
    const n=a=>t.rows.filter(r=>r.action===a).length;
    h+='<h2 style="margin-top:20px">'+escH(t.label)+'</h2>';
    h+='<p class="muted">'+n('create')+' neu · '+n('update')+' geändert · '+n('unchanged')+' unverändert · Einheit: '+escH(t.unit)+' · Quelle: '+escH(t.source)+'</p>';
    if(t.notes) h+='<p class="muted"><em>'+escH(t.notes)+'</em></p>';
    for(const r of t.rejected) h+='<div class="warn">Verworfen: '+escH(r)+'</div>';
    h+='<div class="tablewrap"><table><thead><tr><th>Zeitraum</th><th>Kategorie</th><th class="num">Bisher</th><th class="num">Neu</th><th></th></tr></thead><tbody>';
    for(const r of t.rows){
      const lbl={create:'neu',update:'geändert',unchanged:'gleich'}[r.action];
      h+='<tr class="'+r.action+'"><td>'+escH(r.period)+'</td><td>'+escH(r.category)+'</td><td class="num">'+fmt(r.oldValue)+'</td><td class="num">'+fmt(r.value)+'</td><td><span class="pill">'+lbl+'</span></td></tr>';
    }
    h+='</tbody></table></div>';
  }
  for(const u of plan.unmatched||[]) h+='<div class="warn"><strong>Kein passender Datensatz.</strong> Das Klimadashboard-Team schaut sich das manuell an. <br><em>'+escH(u.notes)+'</em></div>';
  return h;
}`;

/** @param base mount path of the endpoint, e.g. "/data-upload/" */
export function uploadPage(base: string) {
	return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Daten-Upload · Klimadashboard</title><meta name="robots" content="noindex"><style>${CSS}</style></head><body><main>
<h1>Daten-Upload für das Klimadashboard</h1>
<p class="sub" id="sub">Für Städte, Gemeinden und Datenpartner</p>

<section id="login" class="card" hidden>
  <form id="loginForm">
    <label for="email">E-Mail-Adresse</label>
    <p class="muted" style="margin-top:0">Wir schicken Ihnen einen Anmeldelink. Ein Passwort ist nicht nötig.</p>
    <div class="row"><input id="email" type="email" autocomplete="email" required style="flex:1;min-width:200px"><button id="loginBtn">Link anfordern</button></div>
    <div id="loginErr" class="error" hidden></div>
    <p id="loginSent" class="muted" hidden></p>
  </form>
</section>

<section id="app" hidden>
  <p class="muted row" style="justify-content:space-between">Angemeldet als <strong id="who" style="margin-right:auto;margin-left:4px"></strong><button id="logoutBtn" class="secondary" style="padding:4px 10px">Abmelden</button></p>
  <div class="card" id="uploadCard">
    <h2>Neue Daten hochladen</h2>
    <div id="regionRow" style="margin-bottom:16px" hidden>
      <label for="region">Region</label>
      <select id="region"></select>
      <p class="muted" style="margin:6px 0 0">Die Daten werden immer für die hier gewählte Region gespeichert, auch wenn die Datei keine Region nennt.</p>
    </div>
    <div id="drop" class="drop" tabindex="0" role="button">Excel-, CSV- oder PDF-Dateien und Screenshots hierher ziehen,<br>klicken zum Auswählen, oder einen Screenshot mit Strg/⌘+V einfügen.</div>
    <input id="fileInput" type="file" multiple accept=".xlsx,.xls,.xlsm,.ods,.csv,.txt,.pdf,image/png,image/jpeg,image/webp" hidden>
    <ul id="fileList" class="files"></ul>
    <label for="desc">Kurze Beschreibung</label>
    <textarea id="desc" placeholder="z. B. »neue Zulassungszahlen für PKW, Stand Ende September«"></textarea>
    <div id="upErr" class="error" hidden></div>
    <div class="row" style="margin-top:12px"><button id="analyzeBtn" disabled>Auswerten</button><span id="analyzing" class="muted" hidden><span class="spinner"></span>Daten werden ausgewertet – das dauert meist 30–90 Sekunden …</span></div>
    <p class="muted" style="font-size:13px;margin:12px 0 0">Mit dem Klick auf »Auswerten« stimmen Sie zu, dass die hochgeladenen Dateien und Ihre Beschreibung auf dem Server des Klimadashboards gespeichert und für die automatische KI-Auswertung an Anthropic (Claude) übermittelt und dort verarbeitet werden. Bitte laden Sie keine personenbezogenen Daten hoch. Mehr dazu in unserer <a href="https://klimadashboard.org/datenschutz" target="_blank" rel="noopener" style="color:inherit">Datenschutzerklärung</a>.</p>
  </div>

  <div class="card" id="resultCard" hidden>
    <h2>So würden wir die Daten übernehmen</h2>
    <div id="result"></div>
    <div class="row" style="margin-top:16px" id="resultActions">
      <button id="submitBtn">Zur Freigabe senden</button>
      <button id="discardBtn" class="secondary">Verwerfen</button>
    </div>
    <p class="muted" id="submitted" hidden>✓ Eingereicht. Das Klimadashboard-Team prüft die Daten und übernimmt sie ins Dashboard.</p>
  </div>

  <div class="card">
    <h2>Bisherige Uploads</h2>
    <div id="history" class="muted">–</div>
  </div>

  <details class="card"><summary>Welche Daten können hochgeladen werden?</summary><ul id="datasetList"></ul>
  <p class="muted">Andere Daten können trotzdem hochgeladen werden – sie werden dann manuell vom Team bearbeitet. Bei Fragen: team@klimadashboard.org</p></details>
</section>

<script src="${base}app.js"></script></main></body></html>`;
}

export function reviewPage(opts: { base: string; region: string; row: Record<string, any>; plan: Plan | null }) {
	const { base, region, row, plan } = opts;
	return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Upload prüfen · Klimadashboard</title><meta name="robots" content="noindex"><style>${CSS}</style></head><body><main>
<h1>Upload für ${esc(region)}</h1>
<p class="sub">${esc(new Date(row.created_at).toLocaleString("de-DE"))} · ${esc(row.uploaded_by ?? "")} · Status: ${esc(row.status)}</p>
<div class="card"><p><strong>Beschreibung:</strong> ${esc(row.description || "–")}</p><div id="plan"></div></div>
<script type="application/json" id="planData">${JSON.stringify(plan).replace(/</g, "\\u003c")}</script>
<script src="${base}review.js"></script></main></body></html>`;
}

export function magicLinkEmail(link: string, minutes: number) {
	return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.5;color:#1b1f1d;max-width:520px">
<p>Guten Tag,</p>
<p>mit diesem Link melden Sie sich beim Daten-Upload des Klimadashboards an:</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#1f9e80;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">Jetzt anmelden</a></p>
<p style="color:#5d6762">Der Link ist ${minutes} Minuten gültig und kann nur einmal verwendet werden. Falls Sie keine Anmeldung angefordert haben, können Sie diese E-Mail ignorieren.</p>
<p style="color:#5d6762">Team Klimadashboard · team@klimadashboard.org</p>
</div>`;
}

/** Sent to the uploader once the team approved or rejected a submission in Slack. */
export function decisionEmail(opts: {
	approved: boolean;
	region: string;
	createdAt: Date;
	description: string;
	counts?: { created: number; updated: number; unchanged: number };
	portalUrl: string;
}) {
	const { approved, region, createdAt, description, counts, portalUrl } = opts;
	const what = `Ihr Upload für ${esc(region)} vom ${esc(createdAt.toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" }))}${
		description ? ` (»${esc(description)}«)` : ""
	}`;
	const body = approved
		? `<p>${what} wurde vom Klimadashboard-Team geprüft und übernommen${
				counts ? `: ${counts.created} neue und ${counts.updated} aktualisierte Werte` : ""
			}.</p>
<p>Bitte beachten Sie: Es kann einige Stunden dauern, bis die neuen Werte im Klimadashboard sichtbar sind.</p>`
		: `<p>${what} wurde vom Klimadashboard-Team geprüft und <strong>nicht übernommen</strong>.</p>
<p>Wir melden uns bei Ihnen, falls wir Rückfragen haben. Sie können uns auch jederzeit unter team@klimadashboard.org erreichen.</p>`;
	return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.5;color:#1b1f1d;max-width:520px">
<p>Guten Tag,</p>
${body}
<p>Alle bisherigen Uploads und ihren Status finden Sie im <a href="${esc(portalUrl)}" style="color:#1f9e80">Daten-Upload-Portal</a>.</p>
<p style="color:#5d6762">Vielen Dank!<br>Team Klimadashboard · team@klimadashboard.org</p>
</div>`;
}

/*
 * Page scripts are served as files (GET app.js / review.js): Directus' CSP
 * (script-src 'self') blocks inline scripts.
 */
export const UPLOAD_JS = `
const TOKEN_KEY='kd-upload';
const BASE=location.pathname.endsWith('/')?location.pathname:location.pathname+'/';
${RENDER_PLAN_JS}
const $=id=>document.getElementById(id);
let token=null,who=''; try{token=localStorage.getItem(TOKEN_KEY);who=localStorage.getItem(TOKEN_KEY+'-email')||''}catch(e){}
let files=[]; let currentId=null; let regions=[];

async function api(path,opts={}){
  const res=await fetch(BASE+path,{...opts,headers:{...(opts.headers||{}),'X-Upload-Token':token||''}});
  const body=await res.json().catch(()=>({}));
  if(res.status===401&&path!=='api/login'&&path!=='api/verify'){logout();throw new Error(body.error||'Bitte erneut anmelden.')}
  if(!res.ok) throw new Error(body.error||'Fehler '+res.status);
  return body;
}
function show(el,on){el.hidden=!on}
function logout(){token=null;try{localStorage.removeItem(TOKEN_KEY)}catch(e){};show($('app'),false);show($('login'),true)}
async function start(){
  $('who').textContent=who;
  let me; try{me=(await api('api/me')).data}catch(e){return}
  regions=me.regions;
  let saved=null; try{saved=localStorage.getItem(TOKEN_KEY+'-region')}catch(e){}
  $('region').innerHTML=regions.map(r=>'<option value="'+escH(r.id)+'">'+escH(r.label)+'</option>').join('');
  if(regions.some(r=>r.id===saved)) $('region').value=saved;
  show($('regionRow'),regions.length>1);
  $('sub').textContent=regions.map(r=>r.label).join(' · ');
  renderDatasets();show($('login'),false);show($('app'),true);loadHistory();
}
function renderDatasets(){
  const r=regions.find(r=>r.id===$('region').value);
  $('datasetList').innerHTML=(r?r.datasets:[]).map(d=>'<li>'+escH(d.label)+'</li>').join('');
}
$('region').onchange=()=>{try{localStorage.setItem(TOKEN_KEY+'-region',$('region').value)}catch(e){};renderDatasets()};
$('logoutBtn').onclick=logout;

const JSON_POST=body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
$('loginForm').onsubmit=async e=>{
  e.preventDefault();show($('loginErr'),false);show($('loginSent'),false);$('loginBtn').disabled=true;
  try{
    const r=await api('api/login',JSON_POST({email:$('email').value}));
    $('loginSent').textContent=r.data.message;show($('loginSent'),true);
  }catch(err){$('loginErr').textContent=err.message;show($('loginErr'),true)}
  finally{$('loginBtn').disabled=false}
};
async function redeemLink(linkToken){
  history.replaceState(null,'',location.pathname);
  try{
    const r=await api('api/verify',JSON_POST({token:linkToken}));
    token=r.token;who=r.email;try{localStorage.setItem(TOKEN_KEY,token);localStorage.setItem(TOKEN_KEY+'-email',who)}catch(e){}
    start();
  }catch(err){logout();$('loginErr').textContent=err.message;show($('loginErr'),true)}
}

function addFiles(list){for(const f of list) files.push(f);renderFiles()}
function renderFiles(){
  $('fileList').innerHTML=files.map((f,i)=>'<li><span>'+escH(f.name)+' <span class="muted">('+Math.ceil(f.size/1024)+' KB)</span></span><button data-i="'+i+'" aria-label="Entfernen">✕</button></li>').join('');
  $('analyzeBtn').disabled=files.length===0;
}
$('fileList').onclick=e=>{const i=e.target.dataset.i;if(i!==undefined){files.splice(Number(i),1);renderFiles()}};
const drop=$('drop');
drop.onclick=()=>$('fileInput').click();
drop.onkeydown=e=>{if(e.key==='Enter'||e.key===' ')$('fileInput').click()};
$('fileInput').onchange=e=>{addFiles(e.target.files);e.target.value=''};
drop.ondragover=e=>{e.preventDefault();drop.classList.add('over')};
drop.ondragleave=()=>drop.classList.remove('over');
drop.ondrop=e=>{e.preventDefault();drop.classList.remove('over');addFiles(e.dataTransfer.files)};
document.addEventListener('paste',e=>{
  const imgs=[...e.clipboardData.files].filter(f=>f.type.startsWith('image/'));
  if(imgs.length){addFiles(imgs.map((f,i)=>new File([f],'Screenshot '+new Date().toLocaleString('de-DE').replace(/[/:]/g,'-')+(i?'-'+i:'')+'.png',{type:f.type})))}
});

$('analyzeBtn').onclick=async()=>{
  show($('upErr'),false);show($('resultCard'),false);
  const fd=new FormData();fd.append('region',$('region').value);fd.append('description',$('desc').value);for(const f of files) fd.append('files',f,f.name);
  $('analyzeBtn').disabled=true;show($('analyzing'),true);
  try{
    const r=await api('api/analyze',{method:'POST',body:fd});
    currentId=r.data.id;await poll(currentId);
  }catch(err){$('upErr').textContent=err.message;show($('upErr'),true)}
  finally{$('analyzeBtn').disabled=files.length===0;show($('analyzing'),false);loadHistory()}
};

async function poll(id){
  for(;;){
    await new Promise(r=>setTimeout(r,3000));
    const {data}=await api('api/submissions/'+id);
    if(data.status==='analyzing') continue;
    if(data.status==='error') throw new Error(data.error);
    showResult(data);return;
  }
}
function showResult(data){
  currentId=data.id;
  $('result').innerHTML=renderPlan(data.plan);
  const isDraft=data.status==='draft';
  show($('resultActions'),isDraft);show($('submitted'),!isDraft);show($('resultCard'),true);
  $('resultCard').scrollIntoView({behavior:'smooth'});
}
$('submitBtn').onclick=async()=>{
  $('submitBtn').disabled=true;
  try{await api('api/submissions/'+currentId+'/submit',{method:'POST'});show($('resultActions'),false);show($('submitted'),true);files=[];renderFiles();$('desc').value=''}
  catch(err){alert(err.message)}finally{$('submitBtn').disabled=false;loadHistory()}
};
$('discardBtn').onclick=async()=>{await api('api/submissions/'+currentId+'/discard',{method:'POST'}).catch(()=>{});show($('resultCard'),false);loadHistory()};

const STATUS={analyzing:'wird ausgewertet',draft:'Entwurf – noch nicht eingereicht',pending:'wartet auf Freigabe',needs_review:'wird manuell geprüft',applying:'wird übernommen',applied:'übernommen ✓',rejected:'abgelehnt',failed:'Fehler beim Übernehmen',error:'Auswertung fehlgeschlagen'};
async function loadHistory(){
  try{
    const {data}=await api('api/submissions');
    if(!data.length){$('history').textContent='Noch keine Uploads.';return}
    $('history').innerHTML='<div class="tablewrap"><table><thead><tr><th>Datum</th><th>Beschreibung</th><th>Status</th></tr></thead><tbody>'+data.map(s=>'<tr><td>'+new Date(s.created_at).toLocaleString('de-DE',{dateStyle:'short',timeStyle:'short'})+'</td><td style="white-space:normal">'+(regions.length>1?'<strong>'+escH(s.region_label)+'</strong><br>':'')+(s.uploaded_by?'<span class="muted">'+escH(s.uploaded_by)+'</span><br>':'')+(s.status==='draft'?'<a href="#" data-id="'+s.id+'">'+escH(s.description||'(ohne Beschreibung)')+'</a>':escH(s.description||'–'))+'</td><td>'+(STATUS[s.status]||s.status)+'</td></tr>').join('')+'</tbody></table></div>';
  }catch(e){}
}
$('history').onclick=async e=>{const id=e.target.dataset?.id;if(!id)return;e.preventDefault();const {data}=await api('api/submissions/'+id);showResult(data)};

const linkToken=new URLSearchParams(location.search).get('login');
if(linkToken) redeemLink(linkToken); else token?start():logout();
`;

export const REVIEW_JS = `${RENDER_PLAN_JS}
const plan=JSON.parse(document.getElementById('planData').textContent);
document.getElementById('plan').innerHTML=plan?renderPlan(plan):'<p>Keine Auswertung vorhanden.</p>';
`;
