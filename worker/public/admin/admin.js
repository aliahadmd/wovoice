"use strict";

const state={view:"overview",period:"7d",userCursor:null,auditCursor:null,selectedUser:null};
const $=(id)=>document.getElementById(id);
const views={overview:$("view-overview"),users:$("view-users"),detail:$("view-user-detail"),audit:$("view-audit")};

document.addEventListener("DOMContentLoaded",()=>{bind();boot();});

function bind(){
  document.querySelectorAll("[data-view]").forEach((button)=>button.addEventListener("click",()=>showView(button.dataset.view)));
  document.querySelectorAll("[data-period]").forEach((button)=>button.addEventListener("click",()=>{state.period=button.dataset.period;document.querySelectorAll("[data-period]").forEach((item)=>item.classList.toggle("active",item===button));loadOverview();}));
  $("refresh-button").addEventListener("click",refreshCurrent);
  $("user-search-button").addEventListener("click",()=>loadUsers(true));
  $("user-search").addEventListener("keydown",(event)=>{if(event.key==="Enter")loadUsers(true);});
  $("user-status").addEventListener("change",()=>loadUsers(true));
  $("users-more").addEventListener("click",()=>loadUsers(false));
  $("detail-back").addEventListener("click",()=>showView("users"));
  $("audit-action").addEventListener("change",()=>loadAudit(true));
  $("audit-more").addEventListener("click",()=>loadAudit(false));
}

async function boot(){
  try{const session=await api("/session");$("admin-name").textContent=session.admin.email;await loadOverview();}
  catch(error){showGlobalError(error.message);}
}

function showView(name){
  state.view=name;
  Object.entries(views).forEach(([key,value])=>value.classList.toggle("active",key===name));
  document.querySelectorAll("[data-view]").forEach((button)=>button.classList.toggle("active",button.dataset.view===name));
  const labels={overview:["SERVICE OPERATIONS","Overview"],users:["ACCOUNT MANAGEMENT","Users"],detail:["ACCOUNT DETAIL","User"],audit:["ACCOUNTABILITY","Audit log"]};
  $("page-kicker").textContent=labels[name][0];$("page-title").textContent=labels[name][1];hideGlobalError();
  if(name==="users")loadUsers(true);if(name==="audit")loadAudit(true);
}

function refreshCurrent(){if(state.view==="overview")loadOverview();else if(state.view==="users")loadUsers(true);else if(state.view==="detail"&&state.selectedUser)openUser(state.selectedUser);else loadAudit(true);}

async function loadOverview(){
  $("overview-metrics").replaceChildren(...Array.from({length:4},()=>skeletonMetric()));
  try{
    const data=await api(`/overview?period=${encodeURIComponent(state.period)}`);
    const metrics=[
      ["Registered users",formatNumber(data.users.registered),`${formatNumber(data.users.active)} active in period`],
      ["Successful dictations",formatNumber(data.transcription.succeeded),data.transcription.successRate===null?"No requests yet":`${formatPercent(data.transcription.successRate)} success rate`],
      ["Voice processed",formatDuration(data.transcription.audioSeconds),`${formatNumber(data.transcription.quotaRejections)} quota rejections`],
      ["Estimated AI cost",formatUsd(data.usage.estimatedCostUsd),`${formatNumber(data.usage.neurons)} neurons`],
    ];
    $("overview-metrics").replaceChildren(...metrics.map(([label,value,note])=>metric(label,value,note)));
    summary($("transcription-summary"),[
      ["Median processing latency",data.transcription.medianLatencyMs===null?"—":`${formatNumber(data.transcription.medianLatencyMs)} ms`],
      ["Failed dictations",formatNumber(data.transcription.failed)],
      ["New accounts",formatNumber(data.users.newInPeriod)],
      ["Suspended / banned",`${formatNumber(data.users.suspended)} / ${formatNumber(data.users.banned)}`],
      ["Encrypted sync operations",formatNumber(data.service.syncOperations)],
    ]);
    const globalUsed=data.usage.todayGlobalUsedNeurons+data.usage.todayGlobalReservedNeurons;
    const emailUsed=data.service.verificationEmailsThisMonth+data.service.moderationEmailsThisMonth;
    summary($("capacity-summary"),[
      ["Global neurons today",`${formatNumber(globalUsed)} / ${formatNumber(data.usage.todayGlobalLimitNeurons)}`],
      ["Verification emails",formatNumber(data.service.verificationEmailsThisMonth)],
      ["Moderation emails",formatNumber(data.service.moderationEmailsThisMonth)],
      ["Monthly email budget",`${formatNumber(emailUsed)} / ${formatNumber(data.service.monthlyEmailLimit)}`],
      ["Cost reporting","Estimated, not an invoice"],
    ]);
  }catch(error){showGlobalError(error.message);}
}

async function loadUsers(reset){
  if(reset){state.userCursor=null;$("users-body").replaceChildren();}
  setBusy($("user-search-button"),true,"Searching…");
  const params=new URLSearchParams({limit:"50"});
  const query=$("user-search").value.trim();const status=$("user-status").value;
  if(query)params.set("query",query);if(status)params.set("status",status);if(state.userCursor)params.set("cursor",state.userCursor);
  try{
    const data=await api(`/users?${params}`);state.userCursor=data.nextCursor;
    data.users.forEach((user)=>$("users-body").append(userRow(user)));
    const empty=$("users-body").children.length===0;$("users-empty").classList.toggle("hidden",!empty);$("users-more").classList.toggle("hidden",!data.nextCursor);
  }catch(error){showGlobalError(error.message);}finally{setBusy($("user-search-button"),false,"Search");}
}

function userRow(user){
  const row=document.createElement("tr");
  row.append(cell([strong(user.email),small(user.id)]));
  row.append(cell([pill(user.status.state)]));
  row.append(cell([text(formatDate(user.lastActivityAt))]));
  row.append(cell([text(`${formatNumber(user.todayAudioSeconds)} sec`),small(`of ${formatNumber(user.quotaLimitAudioSeconds)} sec`)]));
  row.append(cell([text(formatDuration(user.usage90d.audioSeconds)),small(`${formatNumber(user.usage90d.requests)} requests`)]));
  const button=document.createElement("button");button.className="row-button";button.type="button";button.textContent="Open →";button.addEventListener("click",()=>openUser(user.id));row.append(cell([button]));return row;
}

async function openUser(userId){
  state.selectedUser=userId;showView("detail");$("user-detail").replaceChildren(empty("Loading account…"));
  try{
    const [detail,activity]=await Promise.all([api(`/users/${encodeURIComponent(userId)}`),api(`/users/${encodeURIComponent(userId)}/activity?limit=50`)]);
    renderUserDetail(detail.user,activity.activity);
  }catch(error){$("user-detail").replaceChildren(empty(error.message));}
}

function renderUserDetail(user,activity){
  $("page-title").textContent=user.email;
  const root=$("user-detail");root.replaceChildren();
  const head=document.createElement("div");head.className="panel detail-head";
  const info=document.createElement("div");info.append(text(user.id,"eyebrow"),heading(user.email,2),pill(user.status.state));head.append(info);
  const actions=document.createElement("div");actions.className="action-row";
  if(user.role!=="admin"){
    if(user.status.state!=="suspended")actions.append(actionButton("Suspend","secondary-button",()=>statusDialog(user,"suspended")));
    if(user.status.state!=="banned")actions.append(actionButton("Ban","danger-button",()=>statusDialog(user,"banned")));
    if(user.status.state!=="active")actions.append(actionButton("Restore","primary-button",()=>statusDialog(user,"active")));
    actions.append(actionButton("Quota grant","secondary-button",()=>quotaDialog(user)));
    if(user.quota.overrideExpiresAt)actions.append(actionButton("Clear quota grant","secondary-button",()=>clearQuotaDialog(user)));
    actions.append(actionButton("Revoke sessions","secondary-button",()=>revokeDialog(user)));
  }
  head.append(actions);root.append(head);
  const grid=document.createElement("div");grid.className="detail-grid";
  grid.append(detailPanel("Account",[
    ["Role",user.role],["Created",formatDate(user.createdAt)],["Verified",formatDate(user.verifiedAt)],["Last active",formatDate(user.lastActivityAt)],["Terms",user.termsVersion],["Public status message",user.status.publicMessage||"—"],
  ]),detailPanel("90-day usage",[
    ["Dictation time",formatDuration(user.usage90d.audioSeconds)],["Requests",formatNumber(user.usage90d.requests)],["Neurons",formatNumber(user.usage90d.neurons)],["Today",`${formatNumber(user.quota.todayUsedAudioSeconds)} / ${formatNumber(user.quota.limitAudioSeconds)} sec`],["Quota expiry",formatDate(user.quota.overrideExpiresAt)],
  ]),listPanel("Encrypted sync metadata",user.encryptedSyncMetadata.map((item)=>[capitalize(item.type),`${formatNumber(item.count)} records · ${formatBytes(item.encryptedBytes)}`])));
  grid.append(timelinePanel("Recent activity",activity,"wide"),sessionsPanel(user),notificationsPanel(user));root.append(grid);
}

function statusDialog(user,status){
  const title=status==="active"?"Restore account":status==="suspended"?"Suspend account":"Ban account";
  const fields=[];
  if(status==="suspended")fields.push(field("suspendedUntil","Suspension ends","datetime-local",localInputDate(Date.now()+86_400_000)));
  if(status!=="active")fields.push(field("publicMessage","Message shown to the user","textarea",""));
  fields.push(field("internalReason","Internal reason","textarea","",true,"Required. Never shown or emailed to the user."));
  openDialog({title,kicker:"ACCOUNT STATUS",description:`${title} for ${user.email}. Existing sessions will be revoked.`,confirm:title,destructive:status==="banned",fields,onSubmit:async(values)=>{
    const body={status,internalReason:values.internalReason,publicMessage:values.publicMessage||undefined};
    if(status==="suspended")body.suspendedUntil=new Date(values.suspendedUntil).getTime();
    await api(`/users/${encodeURIComponent(user.id)}/status`,{method:"POST",body});toast(`${title} completed.`);await openUser(user.id);
  }});
}

function quotaDialog(user){
  openDialog({title:"Temporary quota grant",kicker:"FREE BETA QUOTA",description:"Increase this user’s daily voice allowance without bypassing the service-wide AI budget.",confirm:"Grant quota",fields:[field("limitAudioSeconds","Daily seconds","number",String(Math.max(600,user.quota.limitAudioSeconds)),true,"600–3,600 seconds"),field("expiresAt","Grant expires","datetime-local",localInputDate(Date.now()+7*86_400_000)),field("internalReason","Internal reason","textarea","",true)],onSubmit:async(values)=>{await api(`/users/${encodeURIComponent(user.id)}/quota-override`,{method:"PUT",body:{limitAudioSeconds:Number(values.limitAudioSeconds),expiresAt:new Date(values.expiresAt).getTime(),internalReason:values.internalReason}});toast("Quota grant saved.");await openUser(user.id);}});
}

function clearQuotaDialog(user){
  openDialog({title:"Clear quota grant",kicker:"FREE BETA QUOTA",description:"Return this user to the standard 600-second daily allowance.",confirm:"Clear grant",fields:[field("internalReason","Internal reason","textarea","",true)],onSubmit:async(values)=>{await api(`/users/${encodeURIComponent(user.id)}/quota-override/clear`,{method:"POST",body:{internalReason:values.internalReason}});toast("Quota grant cleared.");await openUser(user.id);}});
}

function revokeDialog(user){
  openDialog({title:"Revoke device sessions",kicker:"SECURITY ACTION",description:"All signed-in Android devices will need to verify the account again.",confirm:"Revoke all",destructive:true,fields:[field("internalReason","Internal reason","textarea","",true)],onSubmit:async(values)=>{await api(`/users/${encodeURIComponent(user.id)}/sessions/revoke`,{method:"POST",body:{scope:"all",internalReason:values.internalReason}});toast("Sessions revoked.");await openUser(user.id);}});
}

async function loadAudit(reset){
  if(reset){state.auditCursor=null;$("audit-list").replaceChildren();}
  const params=new URLSearchParams({limit:"50"});if(state.auditCursor)params.set("cursor",state.auditCursor);if($("audit-action").value)params.set("action",$("audit-action").value);
  try{const data=await api(`/audit?${params}`);state.auditCursor=data.nextCursor;data.audit.forEach((item)=>$("audit-list").append(auditItem(item)));const emptyState=$("audit-list").children.length===0;$("audit-empty").classList.toggle("hidden",!emptyState);$("audit-more").classList.toggle("hidden",!data.nextCursor);}catch(error){showGlobalError(error.message);}
}

function auditItem(item){const element=document.createElement("article");element.className="timeline-item";element.append(dot());const body=document.createElement("div");body.append(heading(humanize(item.action),3),text(item.internalReason),small(`Target: ${item.targetUserId||"deleted account"} · Request: ${item.requestId}`));element.append(body);element.append(time(item.createdAt));return element;}

function openDialog(config){
  const dialog=$("action-dialog"),form=$("action-form"),fields=$("dialog-fields");$("dialog-title").textContent=config.title;$("dialog-kicker").textContent=config.kicker;$("dialog-description").textContent=config.description;$("dialog-error").classList.add("hidden");fields.replaceChildren(...config.fields.map(renderField));$("dialog-submit").textContent=config.confirm;$("dialog-submit").className=config.destructive?"danger-button":"primary-button";
  const submit=async(event)=>{if(event.submitter?.value!=="default")return;event.preventDefault();const values=Object.fromEntries(new FormData(form).entries());setBusy($("dialog-submit"),true,"Working…");try{await config.onSubmit(values);dialog.close();}catch(error){$("dialog-error").textContent=error.message;$("dialog-error").classList.remove("hidden");}finally{setBusy($("dialog-submit"),false,config.confirm);}};
  form.addEventListener("submit",submit,{once:true});dialog.showModal();
}

function field(name,label,type,value,required=false,note=""){return{name,label,type,value,required,note};}
function renderField(config){const wrap=document.createElement("div");wrap.className="field";const label=document.createElement("label");label.htmlFor=`field-${config.name}`;label.textContent=config.label;const input=config.type==="textarea"?document.createElement("textarea"):document.createElement("input");input.id=`field-${config.name}`;input.name=config.name;if(config.type!=="textarea")input.type=config.type;input.value=config.value;input.required=config.required;if(config.type==="number"){input.min="600";input.max="3600";}wrap.append(label,input);if(config.note)wrap.append(small(config.note));return wrap;}

function metric(label,value,note){const card=document.createElement("article");card.className="metric";card.append(text(label),strong(value),small(note));return card;}
function skeletonMetric(){return metric("Loading","—","Please wait");}
function summary(root,rows){root.className="summary-list";root.replaceChildren(...rows.map(([label,value])=>{const row=document.createElement("div");row.className="summary-row";row.append(text(label),strong(value));return row;}));}
function detailPanel(title,rows){const panel=document.createElement("article");panel.className="panel";panel.append(heading(title,2));const grid=document.createElement("div");grid.className="kv-grid";rows.forEach(([label,value])=>{const item=document.createElement("div");item.className="kv";item.append(text(label,"label"),text(value===null||value===undefined?"—":String(value),"div"));grid.append(item);});panel.append(grid);return panel;}
function listPanel(title,rows){const panel=document.createElement("article");panel.className="panel";panel.append(heading(title,2));const list=document.createElement("div");list.className="summary-list";(rows.length?rows:[["No encrypted records","—"]]).forEach(([label,value])=>{const row=document.createElement("div");row.className="summary-row";row.append(text(label),strong(value));list.append(row);});panel.append(list);return panel;}
function timelinePanel(title,items,extra=""){const panel=document.createElement("article");panel.className=`panel ${extra}`;panel.append(heading(title,2));const list=document.createElement("div");list.className="timeline";(items.length?items:[]).forEach((item)=>{const row=document.createElement("article");row.className="timeline-item";row.append(dot());const body=document.createElement("div");body.append(heading(humanize(item.type),3),text(activityNote(item)),item.requestId?small(`Request: ${item.requestId}`):document.createTextNode(""));row.append(body,time(item.createdAt));list.append(row);});if(!items.length)list.append(empty("No retained activity."));panel.append(list);return panel;}
function sessionsPanel(user){const rows=user.sessions.map((session)=>[session.deviceName,`${formatDate(session.lastSeenAt)}${session.revokedAt?" · revoked":""}`]);return listPanel("Device sessions",rows);}
function notificationsPanel(user){const panel=listPanel("Moderation notices",user.notifications.map((notice)=>[`${capitalize(notice.action)} · ${notice.status}`,formatDate(notice.sentAt||notice.createdAt)]));panel.querySelectorAll(".summary-row").forEach((row,index)=>{const notice=user.notifications[index];if(notice?.status==="failed"){const button=actionButton("Retry","secondary-button",()=>retryNotice(user,notice));row.append(button);}});return panel;}
function retryNotice(user,notice){openDialog({title:"Retry account notice",kicker:"EMAIL DELIVERY",description:"Retry this failed moderation email.",confirm:"Retry notice",fields:[field("internalReason","Internal reason","textarea","Retry failed account notice",true)],onSubmit:async(values)=>{await api(`/notifications/${encodeURIComponent(notice.id)}/retry`,{method:"POST",body:{internalReason:values.internalReason}});toast("Notice queued for retry.");await openUser(user.id);}});}
function activityNote(item){const values=[];if(item.outcomeCode)values.push(item.outcomeCode);if(item.audioSeconds!==null&&item.audioSeconds!==undefined)values.push(formatDuration(item.audioSeconds));if(item.model)values.push(item.model);if(item.latencyMs!==null&&item.latencyMs!==undefined)values.push(`${formatNumber(item.latencyMs)} ms`);if(item.itemCount!==null&&item.itemCount!==undefined)values.push(`${formatNumber(item.itemCount)} items`);return values.join(" · ")||"Operational event";}

async function api(path,options={}){const init={method:options.method||"GET",credentials:"same-origin",headers:{Accept:"application/json"}};if(options.body){init.headers["Content-Type"]="application/json";init.body=JSON.stringify(options.body);}const response=await fetch(`/admin/api/v1${path}`,init);const body=await response.json().catch(()=>null);if(!response.ok)throw new Error(body?.error?.message||`Admin request failed (${response.status}).`);return body;}
function showGlobalError(message){$("global-error").textContent=message;$("global-error").classList.remove("hidden");}
function hideGlobalError(){$("global-error").classList.add("hidden");}
function toast(message){const node=$("toast");node.textContent=message;node.classList.remove("hidden");window.setTimeout(()=>node.classList.add("hidden"),3200);}
function setBusy(button,busy,label){button.disabled=busy;button.textContent=label;}
function actionButton(label,className,listener){const button=document.createElement("button");button.type="button";button.className=className;button.textContent=label;button.addEventListener("click",listener);return button;}
function cell(children){const td=document.createElement("td");td.append(...children);return td;}
function text(value,className=""){const node=document.createElement(className||"span");node.textContent=value??"—";return node;}
function strong(value){const node=document.createElement("strong");node.textContent=value;return node;}
function small(value){const node=document.createElement("small");node.textContent=value;return node;}
function heading(value,level){const node=document.createElement(`h${level}`);node.textContent=value;return node;}
function pill(value){const node=document.createElement("span");node.className=`status-pill ${value}`;node.textContent=value;return node;}
function dot(){const node=document.createElement("span");node.className="timeline-dot";return node;}
function time(value){const node=document.createElement("time");node.dateTime=value?new Date(value).toISOString():"";node.textContent=formatDate(value);return node;}
function empty(value){return text(value,"div");}
function formatNumber(value){return new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(Number(value)||0);}
function formatPercent(value){return new Intl.NumberFormat(undefined,{style:"percent",maximumFractionDigits:1}).format(value);}
function formatUsd(value){return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:4,maximumFractionDigits:6}).format(Number(value)||0);}
function formatDuration(seconds){const value=Math.max(0,Number(seconds)||0);if(value<60)return `${Math.round(value)} sec`;const hours=Math.floor(value/3600),minutes=Math.round((value%3600)/60);return hours?`${hours}h ${minutes}m`:`${minutes} min`;}
function formatDate(value){if(!value)return "—";return new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(new Date(value));}
function formatBytes(value){return new Intl.NumberFormat(undefined,{style:"unit",unit:"byte",notation:"compact",unitDisplay:"narrow"}).format(Number(value)||0);}
function humanize(value){return String(value).replaceAll("_"," ").replace(/\b\w/g,(letter)=>letter.toUpperCase());}
function capitalize(value){return String(value).charAt(0).toUpperCase()+String(value).slice(1);}
function localInputDate(value){const date=new Date(value-dateOffset(value));return date.toISOString().slice(0,16);}
function dateOffset(value){return new Date(value).getTimezoneOffset()*60_000;}
