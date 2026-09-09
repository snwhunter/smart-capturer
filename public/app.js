const $ = s => document.querySelector(s);
const state = {
  mode:'image',
  files:[],
  text:'',
  analysis:null,
  sharedContext:null,
  batch:false,
  accessKey:localStorage.getItem('smartCapturerAccessKey')||''
};

async function apiFetch(url, options={}){
  options.headers={...(options.headers||{}),'x-smart-capturer-key':state.accessKey};
  let r=await fetch(url,options);
  if(r.status===401){
    const key=prompt('Smart Capturer family access code:')||'';
    if(!key) throw new Error('Family access code required');
    state.accessKey=key;
    localStorage.setItem('smartCapturerAccessKey',key);
    options.headers={...(options.headers||{}),'x-smart-capturer-key':key};
    r=await fetch(url,options);
    if(r.status===401){
      localStorage.removeItem('smartCapturerAccessKey');
      state.accessKey='';
      throw new Error('Incorrect family access code');
    }
  }
  return r;
}

async function responseJsonOrThrow(r){
  let payload={};
  try { payload=await r.json(); } catch {}
  if(!r.ok) throw new Error(payload.error || payload.message || `Request failed (${r.status})`);
  return payload;
}

const modes=[...document.querySelectorAll('.mode')];
const panes={image:$('#imagePane'),link:$('#linkPane'),data:$('#dataPane')};
modes.forEach(btn=>btn.addEventListener('click',()=>setMode(btn.dataset.mode)));

function setMode(mode){
  state.mode=mode;
  modes.forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
  Object.entries(panes).forEach(([k,p])=>p.classList.toggle('active',k===mode));
  resetCurrent(false);
}

$('#cameraInput').addEventListener('change',e=>handleFiles([...e.target.files]));
$('#fileInput').addEventListener('change',e=>handleFiles([...e.target.files]));
$('#analyzeLink').addEventListener('click',()=>analyzeText('link',$('#linkInput').value.trim()));
$('#analyzeData').addEventListener('click',()=>analyzeText('data',$('#dataInput').value.trim()));

async function handleFiles(files){
  if(!files.length) return;
  const images=files.filter(f=>!f.type || f.type.startsWith('image/'));
  if(!images.length){
    setStatus('No image file was selected.');
    return;
  }

  const totalBytes=images.reduce((n,f)=>n+(f.size||0),0);
  if(totalBytes>22*1024*1024){
    setStatus('These images are too large to send together. Try fewer images at a time.');
    return;
  }

  state.files=images;
  state.text='';
  showPreview(images);

  if(state.batch && state.sharedContext){
    fillContext(state.sharedContext,true);
    return;
  }

  setStatus(`Analyzing ${images.length>1 ? images.length+' images' : 'image'}…`);
  const file=await filePayload(images[0]);
  try{
    const result=await responseJsonOrThrow(await apiFetch('/api/analyze',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({kind:'image',file})
    }));
    fillContext(result);
    if(result.warning) setStatus(`AI fallback: ${result.warning}`);
  } catch(e){
    fillContext(localGuess('image','',images[0]?.name));
    setStatus(`AI unavailable: ${e.message}`);
  }
}

async function analyzeText(kind,text){
  if(!text) return;
  state.files=[];
  state.text=text;
  if(state.batch && state.sharedContext){
    fillContext(state.sharedContext,true);
    return;
  }
  setStatus('Analyzing context…');
  try{
    const result=await responseJsonOrThrow(await apiFetch('/api/analyze',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({kind,text})
    }));
    fillContext(result);
    if(result.warning) setStatus(`AI fallback: ${result.warning}`);
  } catch(e){
    fillContext(localGuess(kind,text,''));
    setStatus(`AI unavailable: ${e.message}`);
  }
}

function localGuess(kind,text,filename=''){
  const s=(text+' '+filename).toLowerCase();
  let category='Other';
  if(/receipt|invoice|oreilly|o'reilly|autozone|napa/.test(s)) category='Receipt';
  else if(/recipe|ingredient|instagram|reel|cook/.test(s)) category='Recipe';
  return {
    category,
    title:filename||'New capture',
    context:text,
    tags:[],
    confidence:.25,
    destination_hint:category,
    extracted:{},
    source:'browser-fallback'
  };
}

function fillContext(a,fromShared=false){
  state.analysis=a;
  $('#category').value=[...$('#category').options].some(o=>o.value===a.category)?a.category:'Other';
  $('#title').value=a.title||'';
  $('#context').value=a.context||'';
  $('#tags').value=Array.isArray(a.tags)?a.tags.join(', '):(a.tags||'');
  $('#destination').value=a.destination_hint||'';
  $('#confidence').textContent=fromShared?'Shared context':`${Math.round((a.confidence||0)*100)}% guess`;
  $('#contextCard').classList.remove('hidden');
  $('#status').classList.add('hidden');
  $('#contextCard').scrollIntoView({behavior:'smooth',block:'start'});
}

$('#saveCapture').addEventListener('click',saveCapture);
async function saveCapture(){
  const metadata={
    kind:state.mode,
    category:$('#category').value,
    title:$('#title').value,
    context:$('#context').value,
    tags:$('#tags').value.split(',').map(s=>s.trim()).filter(Boolean),
    destination:$('#destination').value,
    original_text:state.text,
    extracted:state.analysis?.extracted||{},
    analysis_source:state.analysis?.source||'shared-context'
  };

  const expectedFiles=state.files.length;
  if(state.mode==='image' && expectedFiles===0){
    setStatus('No image is attached to this capture. Choose or take a photo first.');
    return;
  }

  try{
    $('#saveCapture').disabled=true;
    setStatus(expectedFiles ? `Saving ${expectedFiles} image${expectedFiles===1?'':'s'}…` : 'Saving capture…');
    const files=await Promise.all(state.files.map(filePayload));
    const saved=await responseJsonOrThrow(await apiFetch('/api/save',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({metadata,files})
    }));

    if(expectedFiles && saved.file_count!==expectedFiles){
      throw new Error(`Server reported ${saved.file_count ?? 0} of ${expectedFiles} images saved.`);
    }

    addRecent({
      ...metadata,
      id:saved.id,
      created_at:new Date().toISOString(),
      file_count:saved.file_count||0,
      bytes_saved:saved.bytes_saved||0,
      saved_files:saved.saved_files||[]
    });

    if($('#reuseContext').checked || state.batch){
      state.sharedContext={
        category:metadata.category,
        title:metadata.title,
        context:metadata.context,
        tags:metadata.tags,
        confidence:1,
        destination_hint:metadata.destination,
        extracted:{}
      };
      state.batch=true;
      updateBatchUI();
    }

    const success=expectedFiles
      ? `Saved ${saved.file_count} image${saved.file_count===1?'':'s'} (${formatBytes(saved.bytes_saved||0)}).`
      : 'Capture saved.';
    resetCurrent(true);
    setStatus(success);
  } catch(e){
    setStatus(`Could not save: ${e.message}`);
  } finally {
    $('#saveCapture').disabled=false;
  }
}

$('#batchToggle').addEventListener('click',()=>{
  state.batch=!state.batch;
  if(!state.batch) state.sharedContext=null;
  updateBatchUI();
});

$('#finishBatch').addEventListener('click',()=>{
  state.batch=false;
  state.sharedContext=null;
  updateBatchUI();
});

function updateBatchUI(){
  $('#batchToggle').textContent=state.batch?'Batch on':'Batch off';
  $('#batchToggle').setAttribute('aria-pressed',String(state.batch));
  $('#batchCard').classList.toggle('hidden',!state.batch);
  $('#batchSummary').textContent=state.sharedContext
    ? `${state.sharedContext.category} · ${state.sharedContext.context || state.sharedContext.title || 'Shared context'}`
    : 'Capture the first item, confirm its context, then choose “Use this same context”.';
}

$('#startOver').addEventListener('click',()=>resetCurrent(true));

function resetCurrent(clearInputs=true){
  state.files=[];
  state.text='';
  state.analysis=null;
  $('#contextCard').classList.add('hidden');
  $('#preview').classList.add('hidden');
  $('#status').classList.add('hidden');
  if(clearInputs){
    $('#cameraInput').value='';
    $('#fileInput').value='';
    $('#linkInput').value='';
    $('#dataInput').value='';
    $('#reuseContext').checked=false;
  }
}

function setStatus(t){
  $('#status').textContent=t;
  $('#status').classList.remove('hidden');
}

function showPreview(files){
  const p=$('#preview');
  p.innerHTML='';
  p.classList.remove('hidden');
  files.slice(0,9).forEach(f=>{
    const img=document.createElement('img');
    const url=URL.createObjectURL(f);
    img.src=url;
    img.onload=()=>URL.revokeObjectURL(url);
    img.alt=f.name||'Selected image';
    p.appendChild(img);
  });
}

function addRecent(item){
  const arr=JSON.parse(localStorage.getItem('smartCapturerRecent')||'[]');
  arr.unshift(item);
  localStorage.setItem('smartCapturerRecent',JSON.stringify(arr.slice(0,12)));
  renderRecent();
}

function renderRecent(){
  const arr=JSON.parse(localStorage.getItem('smartCapturerRecent')||'[]');
  $('#recentList').innerHTML=arr.length
    ? arr.map(x=>{
        const fileText=x.file_count ? ` · ${x.file_count} image${x.file_count===1?'':'s'}` : '';
        return `<div class="recent-item"><div><strong>${esc(x.title||x.category)}</strong><span class="recent-meta">${esc(x.category)} · ${esc(x.destination||'Inbox')}${fileText}</span></div><span class="recent-meta">${new Date(x.created_at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</span></div>`;
      }).join('')
    : '<p class="muted">Nothing captured yet.</p>';
}

async function filePayload(file){
  return {
    name:file.name,
    type:file.type,
    size:file.size,
    lastModified:file.lastModified,
    dataUrl:await new Promise((resolve,reject)=>{
      const r=new FileReader();
      r.onload=()=>resolve(r.result);
      r.onerror=()=>reject(r.error||new Error('Could not read image'));
      r.readAsDataURL(file);
    })
  };
}

function formatBytes(bytes){
  if(bytes<1024) return `${bytes} B`;
  if(bytes<1024*1024) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/(1024*1024)).toFixed(1)} MB`;
}

function esc(s=''){
  return String(s).replace(/[&<>"']/g,c=>({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[c]));
}

if('serviceWorker' in navigator){
  navigator.serviceWorker.register('/sw.js').then(reg=>reg.update()).catch(()=>{});
}
renderRecent();
updateBatchUI();
