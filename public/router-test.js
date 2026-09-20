const form=document.querySelector('#routerForm');
const filesInput=document.querySelector('#files');
const textInput=document.querySelector('#text');
const forceDomain=document.querySelector('#forceDomain');
const notes=document.querySelector('#notes');
const locked=document.querySelector('#locked');
const status=document.querySelector('#status');
const result=document.querySelector('#result');
let accessKey=localStorage.getItem('smartCapturerAccessKey')||'';

async function apiFetch(url,options={}){
  options.headers={...(options.headers||{}),'x-smart-capturer-key':accessKey};
  let response=await fetch(url,options);
  if(response.status===401){
    const key=prompt('Smart Capturer family access code:')||'';
    if(!key) throw new Error('Family access code required');
    accessKey=key; localStorage.setItem('smartCapturerAccessKey',key);
    options.headers={...(options.headers||{}),'x-smart-capturer-key':key};
    response=await fetch(url,options);
  }
  let payload={}; try{payload=await response.json();}catch{}
  if(!response.ok) throw new Error(payload.error||`Request failed (${response.status})`);
  return payload;
}

function asDataUrl(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result);
    reader.onerror=()=>reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function loadDomains(){
  try{
    const health=await apiFetch('/api/router');
    for(const agent of health.agents||[]){
      const option=document.createElement('option');
      option.value=agent.name; option.textContent=`${agent.name} — ${agent.description}`;
      forceDomain.append(option);
    }
  }catch(error){ status.textContent=error.message; }
}
loadDomains();

form.addEventListener('submit',async event=>{
  event.preventDefault();
  status.textContent='Routing…'; result.textContent='';
  try{
    const selected=[...filesInput.files].slice(0,4);
    const files=await Promise.all(selected.map(async file=>({name:file.name,dataUrl:await asDataUrl(file)})));
    let lockedContext={};
    if(locked.value.trim()) lockedContext=JSON.parse(locked.value);
    const payload={
      capture_id:`manual-${Date.now()}`,
      text:textInput.value,
      notes:notes.value,
      force_domain:forceDomain.value,
      locked_context:lockedContext,
      files
    };
    const response=await apiFetch('/api/router/test',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify(payload)
    });
    result.textContent=JSON.stringify(response,null,2);
    status.textContent=`${response.status}: ${response.routing?.domain||'unknown'} (${Math.round((response.routing?.confidence||0)*100)}%)`;
  }catch(error){
    status.textContent=`Error: ${error.message}`;
    result.textContent='';
  }
});
