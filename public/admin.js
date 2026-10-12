(function(){
"use strict";
const $ = id=>document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const REFRESH_MS = 30000;
let csrfToken = "", authenticated = false, days = 7, stats = null, loading = false;
let refreshTimer = null, refreshController = null, refreshSequence = 0, lastUpdated = 0;
let configured = true, loginBusy = false, checkingSession = false;
const number = value=>typeof value==="number" && Number.isFinite(value) && value>=0 ? value : null;
const text = (value,limit=180)=>typeof value==="string" ? value.slice(0,limit) : "";
const list = value=>Array.isArray(value) ? value.filter(item=>item && typeof item==="object" && !Array.isArray(item)) : [];
const count = value=>number(value)===null ? "-" : Math.round(value).toLocaleString();
const percent = value=>number(value)===null ? "-" : Math.min(100,value).toLocaleString(undefined,{maximumFractionDigits:1})+"%";
const money = value=>number(value)===null ? "-" : new Intl.NumberFormat(undefined,{style:"currency",currency:"USD",minimumFractionDigits:2,maximumFractionDigits:value>0 && value<0.01 ? 5 : 3}).format(value);
function element(tag,attrs={},...children){
  const node = document.createElement(tag);
  for(const [key,value] of Object.entries(attrs)){
    if(key==="text") node.textContent=value;
    else if(key==="class") node.className=value;
    else node.setAttribute(key,String(value));
  }
  children.forEach(child=>{ if(child!==null && child!==undefined) node.append(child); });
  return node;
}
function setText(id,value){ $(id).textContent=value; }
function validDate(value){ if(typeof value!=="string" || !value) return null; const date=new Date(value); return Number.isFinite(date.getTime()) ? date : null; }
function dateTime(value){ const date=validDate(value); return date ? date.toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}) : "Not available"; }
function utcPeriod(start,end){ const a=validDate(start), b=validDate(end); return a && b ? `${a.toISOString().slice(0,16).replace("T"," ")} to ${b.toISOString().slice(0,16).replace("T"," ")} UTC` : "Period not available"; }
function loginMessage(message,error=false){ setText("loginStatus",message); $("loginStatus").classList.toggle("error",error); }
function notice(message,kind=""){
  $("dataNotice").className="data-notice"+(kind ? " "+kind : "");
  $("dataNotice").replaceChildren(...(kind==="loading" ? [element("span",{class:"spinner","aria-hidden":"true"})] : []),document.createTextNode(message));
}
class RequestError extends Error{
  constructor(message,status=0){ super(message); this.name="RequestError"; this.status=status; }
}
async function request(path,options={}){
  const controller=new AbortController();
  const stop=()=>controller.abort();
  if(options.signal){ if(options.signal.aborted) stop(); else options.signal.addEventListener("abort",stop,{once:true}); }
  const timeout=setTimeout(stop,20000);
  try{
    const response=await fetch(path,{...options,signal:controller.signal,credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json",...options.headers}});
    const source=await response.text();
    if(source.length>1024*1024) throw new RequestError("The dashboard response was too large. Please try again.",response.status);
    let data;
    try{ data=JSON.parse(source); }catch{ throw new RequestError("The server returned an unreadable response. Please try again.",response.status); }
    if(!response.ok) throw new RequestError(text(data?.error,350) || "The dashboard could not connect. Please try again.",response.status);
    if(!data || typeof data!=="object" || Array.isArray(data)) throw new RequestError("The dashboard response was incomplete.",response.status);
    return data;
  }catch(error){
    if(error.name==="AbortError"){
      if(options.signal?.aborted) throw error;
      throw new RequestError("The request took too long. Check your connection and try again.");
    }
    if(error instanceof RequestError) throw error;
    throw new RequestError("Could not reach the dashboard. Check your connection and try again.");
  }finally{ clearTimeout(timeout); options.signal?.removeEventListener("abort",stop); }
}
function syncLogin(){
  const busy=loginBusy || checkingSession;
  $("loginForm").setAttribute("aria-busy",String(busy));
  $("adminPassword").disabled=busy || !configured || !csrfToken;
  $("passwordToggle").disabled=busy || !configured || !csrfToken;
  $("loginBtn").disabled=busy || !configured || !csrfToken;
  $("retrySessionBtn").disabled=busy;
  setText("loginBtn",loginBusy ? "Signing in…" : "Sign in");
}
function showLogin(message,error=false){
  authenticated=false; clearTimeout(refreshTimer); refreshController?.abort(); refreshSequence++;
  $("dashboard").hidden=true; $("loginView").hidden=false; $("logoutBtn").hidden=true;
  stats=null; lastUpdated=0; loading=false; clearDashboard();
  $("retrySessionBtn").hidden=!error;
  $("adminPassword").value=""; $("adminPassword").type="password"; $("adminPassword").removeAttribute("aria-invalid");
  $("passwordToggle").setAttribute("aria-pressed","false"); setText("passwordToggle","Show");
  $("copyDialog").open && $("copyDialog").close();
  $("copyText").value=""; loginMessage(message,error); syncLogin();
}
function showDashboard(){
  authenticated=true; $("loginView").hidden=true; $("dashboard").hidden=false; $("logoutBtn").hidden=false;
  $("adminPassword").value=""; $("adminPassword").type="password"; $("passwordToggle").setAttribute("aria-pressed","false"); setText("passwordToggle","Show");
}
async function checkSession(message=""){
  if(checkingSession) return;
  checkingSession=true; csrfToken=""; $("retrySessionBtn").hidden=true; syncLogin();
  try{
    const session=await request("/api/admin/session");
    configured=session.configured!==false;
    csrfToken=text(session.csrfToken,512);
    if(session.authenticated===true){
      if(!csrfToken) throw new RequestError("Your session could not be verified. Reload to try again.");
      showDashboard(); await refresh();
    }else{
      showLogin(message || (configured ? "Enter your admin password to continue." : "Admin sign-in is not configured yet. Set up the dashboard password and session secret on the server."),!configured);
      if(configured && !csrfToken){ loginMessage("The sign-in session could not start. Retry the connection.",true); $("retrySessionBtn").hidden=false; }
    }
  }catch(error){ showLogin(error.message,true); }
  finally{ checkingSession=false; syncLogin(); }
}
$("retrySessionBtn").addEventListener("click",()=>{ if(!loginBusy) checkSession(); });
$("passwordToggle").addEventListener("click",()=>{
  const visible=$("adminPassword").type==="password";
  $("adminPassword").type=visible ? "text" : "password";
  $("passwordToggle").setAttribute("aria-pressed",String(visible)); setText("passwordToggle",visible ? "Hide" : "Show");
});
$("loginForm").addEventListener("submit",async event=>{
  event.preventDefault();
  if(loginBusy || !configured || !csrfToken || !$("adminPassword").value) return;
  loginBusy=true; syncLogin(); loginMessage("Signing in securely…");
  try{
    const result=await request("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":csrfToken},body:JSON.stringify({password:$("adminPassword").value,csrfToken})});
    if(result.authenticated!==true || typeof result.csrfToken!=="string" || !result.csrfToken) throw new RequestError("Sign-in could not be verified. Please try again.");
    csrfToken=result.csrfToken; showDashboard(); await refresh(); $("dashboardTitle").focus({preventScroll:true});
  }catch(error){
    loginMessage(error.message,true);
    $("adminPassword").setAttribute("aria-invalid","true");
    if(error.status===403) await checkSession("Your sign-in session expired. Enter your password and try again.");
  }finally{ loginBusy=false; syncLogin(); }
});
$("adminPassword").addEventListener("input",()=>$("adminPassword").removeAttribute("aria-invalid"));
$("logoutBtn").addEventListener("click",async()=>{
  if(!authenticated || $("logoutBtn").disabled) return;
  $("logoutBtn").disabled=true; clearTimeout(refreshTimer); refreshController?.abort();
  try{
    await request("/api/admin/logout",{method:"POST",headers:{"X-CSRF-Token":csrfToken}});
    csrfToken=""; showLogin("You have signed out."); await checkSession("You have signed out.");
  }catch(error){
    if(error.status===401){ showLogin("Your session has ended. Sign in again to continue."); await checkSession("Your session has ended. Sign in again to continue."); }
    else{ notice("Could not sign out. "+error.message,"error"); scheduleRefresh(); }
  }finally{ $("logoutBtn").disabled=false; }
});

function scheduleRefresh(){
  clearTimeout(refreshTimer);
  if(authenticated && !document.hidden) refreshTimer=setTimeout(()=>refresh(),REFRESH_MS);
}
function busy(value){
  loading=value; $("dashboard").setAttribute("aria-busy",String(value)); $("refreshBtn").disabled=value;
  setText("refreshBtn",value ? "Refreshing…" : "Refresh");
  $("copyStatsBtn").disabled=!stats; $("exportStatsBtn").disabled=!stats;
}
async function refresh(){
  if(!authenticated) return;
  clearTimeout(refreshTimer); refreshController?.abort();
  const sequence=++refreshSequence, requestedDays=days;
  const controller=new AbortController(); refreshController=controller; busy(true);
  if(!stats) notice("Loading your overview…","loading");
  try{
    const data=await request(`/api/admin/stats?days=${requestedDays}`,{signal:controller.signal});
    if(sequence!==refreshSequence || !authenticated) return;
    if(!data.range || !data.totals || !data.live || !data.usage || !data.readiness || Number(data.range.days)!==requestedDays) throw new RequestError("The dashboard response was incomplete. Please try again.");
    if(typeof data.csrfToken==="string" && data.csrfToken) csrfToken=data.csrfToken;
    stats=data; lastUpdated=Date.now(); renderStats(data); $("freshnessDot").className="freshness-dot fresh";
    notice(data.coverage?.firstEventAt ? "Your overview is up to date." : "Tracking is ready. Recorded activity will appear here as visitors arrive.");
  }catch(error){
    if(sequence!==refreshSequence || error.name==="AbortError") return;
    if(error.status===401){ showLogin("Your session has expired. Sign in again to continue."); await checkSession("Your session has expired. Sign in again to continue."); return; }
    $("freshnessDot").className="freshness-dot stale";
    const previous=stats ? ` Showing the last successful ${stats.range.days}-day view.` : "";
    notice(error.message+previous,"error");
    if(!stats) setText("updatedAt","Data unavailable");
  }finally{
    if(sequence===refreshSequence){ busy(false); refreshController=null; scheduleRefresh(); }
  }
}
$("refreshBtn").addEventListener("click",()=>refresh());
document.querySelectorAll("[data-days]").forEach(button=>button.addEventListener("click",()=>{
  const next=Number(button.dataset.days); if(![1,7,30].includes(next) || next===days) return;
  days=next; document.querySelectorAll("[data-days]").forEach(item=>item.setAttribute("aria-pressed",String(item===button))); refresh();
}));
document.addEventListener("visibilitychange",()=>{
  if(document.hidden){ clearTimeout(refreshTimer); setText("refreshNote","Automatic refresh is paused while this tab is hidden."); }
  else{ setText("refreshNote","Refreshes every 30 seconds while this tab is visible."); if(authenticated && !loading && Date.now()-lastUpdated>=REFRESH_MS) refresh(); else scheduleRefresh(); }
});
window.addEventListener("pagehide",()=>{ clearTimeout(refreshTimer); refreshController?.abort(); });

function clearDashboard(){
  ["metricLive","metricVisits","metricSessions","metricReviewRate","metricSuccess","metricFailures","estimatedCost","inputTokens","outputTokens","officialCost"].forEach(id=>setText(id,"-"));
  ["sourceList","countryList","deviceList","funnel","serviceList"].forEach(id=>$(id).replaceChildren());
  ["trendRows","eventRows","campaignRows"].forEach(id=>$(id).replaceChildren());
  $("trendChart").replaceChildren(); $("copyStatsBtn").disabled=true; $("exportStatsBtn").disabled=true;
  setText("updatedAt","Waiting for data"); setText("coverage","Coverage will appear when tracking is connected.");
  setText("tokenCoverage","Token coverage will appear when usage is recorded."); setText("billingCoverage","No organization cost report is connected.");
  setText("liveDefinition","Browser sessions active within the recent tracking window. This is an estimate.");
  setText("reviewRateDefinition","Sessions that started a profile review");
  setText("successDefinition","Completed profile reports");
  setText("failureDefinition","Reviews that could not complete");
  setText("estimatedCostNote","Calculated from recorded token usage. This app estimate is not an invoice or account balance.");
  setText("billingStatus","Not connected"); $("billingStatus").className="status-badge neutral";
  setText("periodLabel",days===1 ? "24-hour view" : days+"-day view");
  $("freshnessDot").className="freshness-dot"; notice("Waiting for data."); busy(false);
}
function renderStats(data){
  const {totals,live,usage,coverage={},range,officialBilling={}}=data;
  setText("metricLive",count(live.activeSessions));
  setText("liveDefinition",`Browser sessions with activity in the last ${count(live.windowSeconds)} seconds. An estimate, not a count of people.`);
  setText("metricVisits",count(totals.pageviews)); setText("metricSessions",count(totals.sessions));
  setText("metricReviewRate",percent(totals.reviewRate));
  setText("reviewRateDefinition",`${count(totals.reviewSessions)} tracked sessions started a review`);
  setText("metricSuccess",count(totals.successfulScans)); setText("metricFailures",count(totals.failedScans));
  setText("successDefinition",number(totals.scans)>0 ? `${percent(totals.scanSuccessRate)} of recorded reviews completed` : "No completed reviews recorded yet");
  setText("failureDefinition",`${count(totals.scans)} review attempts recorded in this period`);
  setText("estimatedCost",money(usage.estimatedUSD));
  setText("inputTokens",count(usage.inputTokens)); setText("outputTokens",count(usage.outputTokens));
  setText("estimatedCostNote",number(usage.estimatedUSD)===null ? "The full app estimate is unavailable because some review usage or pricing is missing. This is not an invoice or account balance." : "Estimated from this app's recorded Anthropic tokens, including cache usage where reported. Excludes voice transcription and activity from other apps.");
  const partial=number(usage.estimatedUSD)===null && number(usage.knownEstimatedUSD)!==null ? ` Known portion: ${money(usage.knownEstimatedUSD)}; this is not the full period cost.` : "";
  setText("tokenCoverage",`${count(usage.pricedScans)} reviews priced · ${count(usage.unpricedScans)} reviews with incomplete usage or pricing.${partial}`);
  const billed=officialBilling.connected && typeof officialBilling.totalUSD==="number";
  setText("officialCost",billed ? money(officialBilling.totalUSD) : "-");
  setText("billingStatus",billed ? "Connected" : officialBilling.configured ? "Not available" : "Not connected");
  $("billingStatus").className="status-badge "+(billed ? "good" : "neutral");
  setText("billingCoverage",text(officialBilling.reason,450) || "No organization cost report is connected. No account-wide cost is inferred from app usage.");
  const first=coverage.firstEventAt || coverage.trackingStart;
  setText("coverage",`${first ? "Tracking since "+dateTime(first) : "No activity recorded yet"} · ${count(coverage.retentionDays)}-day retention · ${utcPeriod(range.start,range.end)}`);
  setText("periodLabel",`${range.days===1 ? "24-hour" : range.days+"-day"} view · Chart buckets use UTC. Other times are local.`);
  setText("updatedAt","Updated "+new Date(lastUpdated).toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit",second:"2-digit"}));
  renderChart(list(data.trend).slice(0,96),range.days);
  renderDistribution("sourceList",data.sources,"No referral sources recorded in this period.");
  renderDistribution("countryList",data.countries,"No country data recorded in this period.");
  renderDistribution("deviceList",data.devices,"No device data recorded in this period.");
  renderCampaigns(data.campaigns); renderFunnel(data.funnel); renderServices(data.readiness); renderEvents(data.recent);
}
function renderDistribution(id,items,empty){
  const rows=list(items).filter(item=>typeof item.label==="string" && number(item.count)!==null).slice(0,8);
  const root=$(id); root.replaceChildren();
  if(!rows.length){ root.append(element("p",{class:"empty-state",text:empty})); return; }
  const total=rows.reduce((sum,row)=>sum+row.count,0), max=Math.max(1,...rows.map(row=>row.count));
  rows.forEach(row=>{
    const bar=element("i"); bar.style.width=(row.count/max*100)+"%";
    root.append(element("div",{class:"distribution-row"},element("span",{class:"distribution-label",text:text(row.label)}),element("span",{class:"distribution-value",text:count(row.count)}),element("div",{class:"distribution-bar","aria-hidden":"true"},bar)));
  });
  if(total===0) root.append(element("p",{class:"panel-footnote",text:"No visits in these recorded categories."}));
}
function renderCampaigns(items){
  const rows=list(items).filter(item=>number(item.count)!==null).slice(0,20), root=$("campaignRows"); root.replaceChildren();
  if(!rows.length){ root.append(element("tr",{},element("td",{colspan:4,class:"empty-state",text:"No tagged campaign traffic recorded in this period."}))); return; }
  rows.forEach(row=>root.append(element("tr",{},...[(text(row.source)||"Untagged"),(text(row.medium)||"-"),(text(row.campaign)||"-"),count(row.count)].map(value=>element("td",{text:value})))));
}
function renderFunnel(items){
  const rows=list(items).filter(item=>typeof item.label==="string" && number(item.count)!==null).slice(0,6), root=$("funnel"); root.replaceChildren();
  if(!rows.length){ root.append(element("p",{class:"empty-state",text:"No review journey data recorded in this period."})); return; }
  rows.forEach(row=>root.append(element("div",{class:"funnel-step"},element("span",{text:text(row.label)}),element("strong",{text:count(row.count)}),element("small",{text:row.event==="session" ? "Tracked browser sessions" : "Recorded activity"}))));
}
function renderServices(readiness){
  const services=[["database","Activity database","Stores aggregate activity records."],["passwordAuth","Private dashboard","Password and session signing are configured."],["telemetryEnabled","Visitor tracking","Recording aggregate visitor activity."],["telemetryLimiter","Tracking protection","Limits incoming tracking events."],["loginLimiter","Sign-in protection","Limits password attempts."],["anthropicKey","Anthropic reviews","The provider API key is configured."]];
  const root=$("serviceList"); root.replaceChildren();
  services.forEach(([key,label,note])=>{
    const known=typeof readiness[key]==="boolean", good=readiness[key]===true;
    root.append(element("article",{class:"service-card"},element("h3",{text:label}),element("span",{class:"status-badge "+(known ? good ? "good" : "warning" : "neutral"),text:known ? good ? "Configured" : "Needs setup" : "Unavailable"}),element("p",{text:note})));
  });
}
const eventLabels={page_view:"Page view",heartbeat:"Activity heartbeat",photo_added:"Photo added",voice_added:"Voice added",scan_started:"Review started",scan:"Review result",http_request:"Server request",photo_edited:"Photo saved",report_downloaded:"Report downloaded"};
function renderEvents(items){
  const rows=list(items).slice(0,16), root=$("eventRows"); root.replaceChildren();
  if(!rows.length){ root.append(element("tr",{},element("td",{colspan:4,class:"empty-state",text:"No recent events recorded in this period."}))); return; }
  rows.forEach(row=>{
    const kind=text(row.event,80), outcome=text(row.outcome,80) || (number(row.status)!==null ? String(row.status) : "Recorded");
    const path=text(row.path,120).split(/[?#]/,1)[0];
    const details=[path,number(row.durationMs)!==null ? Math.round(row.durationMs)+" ms" : "",text(row.model,100)].filter(Boolean).join(" · ") || "-";
    const failure=/fail|error/i.test(outcome) || number(row.status)>=400;
    root.append(element("tr",{},element("td",{text:dateTime(row.timestamp)}),element("td",{text:eventLabels[kind] || kind.replaceAll("_"," ") || "Activity"}),element("td",{},element("span",{class:"status-badge "+(failure ? "bad" : /success|complete/i.test(outcome) ? "good" : "neutral"),text:outcome})),element("td",{text:details})));
  });
}
function svgNode(tag,attrs={},textValue){
  const node=document.createElementNS(NS,tag); Object.entries(attrs).forEach(([key,value])=>node.setAttribute(key,String(value))); if(textValue!==undefined) node.textContent=textValue; return node;
}
function renderChart(items,rangeDays){
  const hourly=rangeDays===1;
  const bucketDate=value=>{
    if(typeof value!=="string" || !(hourly ? /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/ : /^\d{4}-\d{2}-\d{2}$/).test(value)) return null;
    const date=validDate(value);
    if(!date || (hourly ? date.toISOString().replace(".000Z","Z") : date.toISOString().slice(0,10))!==value) return null;
    return date;
  };
  const rows=items.filter(row=>bucketDate(row.date) && number(row.pageviews)!==null && number(row.successfulScans)!==null);
  const root=$("trendChart"), table=$("trendRows"); root.replaceChildren(); table.replaceChildren();
  if(!rows.length){ root.append(element("p",{class:"empty-state",text:"No traffic trend recorded in this period. Your first visits will appear here."})); return; }
  const width=Math.max(270,root.clientWidth || 800), height=220, left=34, right=12, top=15, bottom=32;
  const plotW=width-left-right, plotH=height-top-bottom;
  const highest=Math.max(1,...rows.flatMap(row=>[row.pageviews,row.successfulScans]));
  const maximum=highest<4 ? highest : Math.ceil(highest/4)*4;
  const x=index=>left+(rows.length===1 ? plotW/2 : index/(rows.length-1)*plotW), y=value=>top+plotH-(value/maximum*plotH);
  const svg=svgNode("svg",{viewBox:`0 0 ${width} ${height}`,role:"img","aria-labelledby":"trendSvgTitle trendSvgDescription"});
  svg.append(svgNode("title",{id:"trendSvgTitle"},`Page views and successful profile reviews by UTC ${hourly ? "hour" : "day"}`),svgNode("desc",{id:"trendSvgDescription"},`${rows.length} ${hourly ? "hourly" : "daily"} UTC buckets within the selected period. Full values appear in the table below.`));
  const chartCaption=table.closest?.("table")?.querySelector("caption");
  if(chartCaption) chartCaption.textContent=`Page views and successful reviews by UTC ${hourly ? "hour" : "day"}`;
  for(let index=0;index<=4;index++){
    const value=maximum*index/4, lineY=y(value);
    svg.append(svgNode("line",{x1:left,y1:lineY,x2:width-right,y2:lineY,stroke:"#E5EADF","stroke-width":1}),svgNode("text",{x:left-8,y:lineY+3,"text-anchor":"end",fill:"#68736B","font-size":10,"font-family":"system-ui"},maximum<4 ? value.toFixed(value%1 ? 1 : 0) : count(value)));
  }
  const labelCount=Math.min(rows.length,width<450 ? 3 : 6);
  const labelIndices=new Set(Array.from({length:labelCount},(_,i)=>rows.length===1 ? 0 : Math.round(i/(labelCount-1)*(rows.length-1))));
  rows.forEach((row,index)=>{
    const date=bucketDate(row.date);
    if(labelIndices.has(index)){
      const label=date.toLocaleString(undefined,{timeZone:"UTC",month:"short",day:"numeric",...(hourly ? {hour:"2-digit",hour12:false} : {})});
      svg.append(svgNode("text",{x:x(index),y:height-9,"text-anchor":"middle",fill:"#68736B","font-size":10,"font-family":"system-ui"},label));
    }
    table.append(element("tr",{},element("th",{scope:"row",text:(hourly ? date.toISOString().slice(0,16).replace("T"," ") : date.toISOString().slice(0,10))+" UTC"}),element("td",{text:count(row.pageviews)}),element("td",{text:count(row.successfulScans)})));
  });
  [["pageviews","#244C39"],["successfulScans","#B68833"]].forEach(([key,color])=>{
    svg.append(svgNode("polyline",{points:rows.map((row,index)=>`${x(index)},${y(row[key])}`).join(" "),fill:"none",stroke:color,"stroke-width":2.5,"stroke-linecap":"round","stroke-linejoin":"round"}));
    if(rows.length<=31) rows.forEach((row,index)=>svg.append(svgNode("circle",{cx:x(index),cy:y(row[key]),r:3,fill:color},undefined)));
  });
  root.append(svg);
}
if(typeof ResizeObserver!=="undefined"){
  let previousWidth=0;
  new ResizeObserver(entries=>{ const width=Math.round(entries[0]?.contentRect.width || 0); if(width && width!==previousWidth){ previousWidth=width; if(stats) renderChart(list(stats.trend).slice(0,96),stats.range.days); } }).observe($("trendChart"));
}

function summary(){
  if(!stats) return "";
  const {totals,live,usage,range}=stats;
  return ["KEEP FIX CUT · PRIVATE OVERVIEW",utcPeriod(range.start,range.end),`Updated: ${new Date(lastUpdated).toISOString()}`,"",`Active browser sessions (last ${count(live.windowSeconds)} seconds; estimate): ${count(live.activeSessions)}`,`Tracked page visits: ${count(totals.pageviews)}`,`Tracked sessions: ${count(totals.sessions)}`,`Sessions starting reviews: ${count(totals.reviewSessions)} (${percent(totals.reviewRate)})`,`Successful reviews: ${count(totals.successfulScans)}`,`Failed reviews: ${count(totals.failedScans)}`,`Review success rate: ${percent(totals.scanSuccessRate)}`,"",`Anthropic input tokens (including reported cache usage): ${count(usage.inputTokens)}`,`Anthropic output tokens: ${count(usage.outputTokens)}`,`Estimated app API cost: ${money(usage.estimatedUSD)}`,number(usage.estimatedUSD)===null ? `Known portion only: ${money(usage.knownEstimatedUSD)}` : "Estimate of this app's recorded usage; not an account invoice.","", "TOP REFERRAL SOURCES",...list(stats.sources).slice(0,8).map(row=>`${text(row.label)}: ${count(row.count)}`)].join("\n");
}
$("copyStatsBtn").addEventListener("click",async()=>{
  if(!stats) return;
  const snapshot=stats, value=summary();
  try{ if(!navigator.clipboard?.writeText) throw new Error("clipboard"); await navigator.clipboard.writeText(value); if(authenticated && stats===snapshot) notice("Aggregate overview copied."); }
  catch{
    if(!authenticated || stats!==snapshot) return;
    $("copyText").value=value; $("copyDialog").showModal(); $("copyText").focus(); $("copyText").select();
  }
});
$("copyAttributionBtn").addEventListener("click",async()=>{
  if(!authenticated) return;
  const value=$("attributionLink").value;
  if(typeof value!=="string" || value.length>2048) return;
  try{
    if(!navigator.clipboard?.writeText) throw new Error("clipboard");
    await navigator.clipboard.writeText(value);
    if(authenticated) notice("Tagged Reddit link copied.");
  }catch{
    if(!authenticated) return;
    $("attributionLink").focus(); $("attributionLink").select();
    notice("Select the tagged link, then use your browser's Copy action.");
  }
});
$("copyDoneBtn").addEventListener("click",()=>$("copyDialog").close());
$("copyDialog").addEventListener("close",()=>{ $("copyText").value=""; if(authenticated) $("copyStatsBtn").focus({preventScroll:true}); });
function csvValue(value){
  if(value===null || value===undefined) return "";
  let valueText=String(value);
  if(typeof value==="string" && /^[\s]*[=+\-@]/.test(valueText)) valueText="'"+valueText;
  return '"'+valueText.replaceAll('"','""')+'"';
}
function aggregateCsv(){
  const {range,totals,live,usage,coverage={}}=stats;
  const rows=[["section","label","value","detail"],["period","start_utc",range.start,""],["period","end_utc",range.end,""],["coverage","first_event_utc",coverage.firstEventAt || coverage.trackingStart || "",""],["coverage","retention_days",coverage.retentionDays,""],["live","active_browser_sessions",live.activeSessions,`${live.windowSeconds}-second window; estimate`]];
  for(const key of ["sessions","pageviews","scans","reviewSessions","reviewRate","successfulScans","failedScans","scanSuccessRate"]) rows.push(["totals",key,totals[key],/Rate$/.test(key) ? "percentage" : ""]);
  for(const key of ["inputTokens","outputTokens","cacheReadTokens","cacheCreationTokens","estimatedUSD","knownEstimatedUSD","pricedScans","unpricedScans"]) rows.push(["app_usage",key,usage[key],/USD$/.test(key) ? "App estimate in USD; not invoice/account balance" : ""]);
  for(const category of ["sources","countries","devices"]) list(stats[category]).slice(0,100).forEach(row=>rows.push([category,text(row.label),row.count,""]));
  list(stats.campaigns).slice(0,100).forEach(row=>rows.push(["campaigns",text(row.source),row.count,`${text(row.medium)} / ${text(row.campaign)}`]));
  list(stats.trend).slice(0,96).forEach(row=>{ for(const key of ["sessions","pageviews","scans","successfulScans","failedScans"]) rows.push(["trend",text(row.date),row[key],key]); });
  return "\uFEFF"+rows.map(row=>row.map(csvValue).join(",")).join("\r\n");
}
$("exportStatsBtn").addEventListener("click",()=>{
  if(!stats) return;
  const url=URL.createObjectURL(new Blob([aggregateCsv()],{type:"text/csv;charset=utf-8"}));
  const link=element("a",{href:url,download:`keep-fix-cut-overview-${stats.range.days}d-${new Date(lastUpdated).toISOString().slice(0,10)}.csv`});
  document.body.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),60000); notice("Aggregate CSV download started. Recent event details are not included.");
});
document.querySelectorAll(".sidebar nav a").forEach(link=>link.addEventListener("click",()=>{ document.querySelectorAll(".sidebar nav a").forEach(item=>item.classList.toggle("active",item===link)); }));
syncLogin(); checkSession();
})();
