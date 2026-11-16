/* Owner editor for Joey's Reading Room. Loaded only in a browser that has owner access (token or dry run).
   Edits are expressed as small operations, applied to the freshest library.json on the repo, and written as ONE git commit
   (library.json + any new cover file) through the GitHub Git Data API. No token is ever sent anywhere except api.github.com. */
(function(){
'use strict';
const REPO='joeyweast/reading',API='https://api.github.com';
const OWN=window.RR_OWNER||{};            // {token,branch,dry}
const DBX=Object.fromEntries(DB.books.map(b=>[b.id,b]));
const STATUS=[['read','Read'],['currently-reading','Currently reading'],['to-read','To read'],['did-not-finish','Did not finish']];
const CAP=4,TCAP=5;                                // ceiling; BISAC suggests 3
const q=(s,r)=>(r||document).querySelector(s), qa=(s,r)=>[...(r||document).querySelectorAll(s)];
const E=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone=o=>JSON.parse(JSON.stringify(o));
const today=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};

/* ---------- pure data operations (also exercised by the tests) ---------- */
function applyOps(db,ops){
  db=clone(db);const by=Object.fromEntries(db.books.map(b=>[b.id,b]));
  for(const op of ops){
    if(op.op==='registry'){
      (op.main||[]).forEach(m=>{if(!db.genres.main.some(x=>x.name===m.name))db.genres.main.push({name:m.name,color:m.color})});
      (op.sub||[]).forEach(s=>{if(!db.genres.sub.some(x=>x.name===s.name))db.genres.sub.push(s)});
      db.genres.tags=db.genres.tags||[];(op.tags||[]).forEach(t=>{if(!db.genres.tags.some(x=>x.name===t.name))db.genres.tags.push(t)});
    }else if(op.op==='add'){
      if(by[op.book.id])throw new Error('A book with this id already exists');
      db.books.push(op.book);by[op.book.id]=op.book;
    }else if(op.op==='delete'){
      if(!by[op.id])throw new Error('Book not found: '+op.id+' (already deleted, or changed on another device?)');
      db.books=db.books.filter(b=>b.id!==op.id);delete by[op.id];
    }else if(op.op==='update'){
      const b=by[op.id];if(!b)throw new Error('Book not found: '+op.id+' (changed on another device?)');
      Object.assign(b,op.set||{});
      if(op.addTag||op.removeTag){
        let t=(b.tags||[]).slice();
        (op.removeTag||[]).forEach(x=>{t=t.filter(y=>y!==x)});
        (op.addTag||[]).forEach(x=>{if(!t.includes(x)&&t.length<TCAP)t.push(x)});
        b.tags=t;
      }
      if(op.addSub||op.removeSub){
        let s=b.subgenres.slice();
        (op.removeSub||[]).forEach(x=>{s=s.filter(y=>y!==x)});
        (op.addSub||[]).forEach(x=>{if(!s.includes(x)&&s.length<CAP)s.push(x)});
        b.subgenres=s;
      }
    }
  }
  /* keep the registry honest: every used genre / subgenre exists, and a subgenre's "for" list includes where it is used */
  const mains=new Set(db.genres.main.map(m=>m.name));
  db.genres.tags=db.genres.tags||[];
  for(const b of db.books){
    b.tags=b.tags||[];
    for(const t of b.tags){if(!db.genres.tags.some(x=>x.name===t))db.genres.tags.push({name:t,source:'reader'})}
    if(!mains.has(b.genre))throw new Error('Unknown main genre: '+b.genre);
    for(const s of b.subgenres){
      let e=db.genres.sub.find(x=>x.name===s);
      if(!e){e={name:s,source:'reader'};db.genres.sub.push(e)}
      if(e.for&&!e.for.includes(b.genre))e.for=e.for.concat(b.genre).sort();
    }
  }
  return db;
}
function serialize(db){
  const d=o=>JSON.stringify(o);
  return '{"version":1,"rev":'+(db.rev||0)+',\n"genres":'+d(db.genres)+',\n"books":[\n'+db.books.map(d).join(',\n')+'\n]}\n';
}
function lev(a,b){const m=[...Array(b.length+1).keys()];for(let i=1;i<=a.length;i++){let p=m[0];m[0]=i;for(let j=1;j<=b.length;j++){const t=m[j];m[j]=Math.min(m[j]+1,m[j-1]+1,p+(a[i-1]===b[j-1]?0:1));p=t}}return m[b.length]}
function normName(s){s=String(s||'').trim();if(s.includes(','))s=s.split(',').slice(1).join(' ')+' '+s.split(',')[0];return s.toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim()}
function similarName(val,names){
  if(!val||names.includes(val))return null;const n=normName(val);if(!n)return null;
  for(const x of names){const m=normName(x);if(m===n)return x}
  for(const x of names){const m=normName(x);if(m.length>6&&n.length>6&&lev(m,n)<=2)return x}
  return null;
}
/* the genre-only diff that bulk toggles may spread to other books */
function genreDiff(orig,next){
  return {main:next.genre!==orig.genre?next.genre:null,
          add:next.subgenres.filter(x=>!orig.subgenres.includes(x)),
          remove:orig.subgenres.filter(x=>!next.subgenres.includes(x)),
          tadd:(next.tags||[]).filter(x=>!(orig.tags||[]).includes(x)),
          tremove:(orig.tags||[]).filter(x=>!(next.tags||[]).includes(x))};
}
function diffIsEmpty(d){return !d.main&&!d.add.length&&!d.remove.length&&!d.tadd.length&&!d.tremove.length}
function bulkTargets(cur,bySeries,byAuthor){
  return DB.books.filter(b=>b.id!==cur.id&&((bySeries&&cur.series&&b.series===cur.series)||(byAuthor&&cur.author&&b.author===cur.author)));
}
function describe(b,d){
  const out=[];
  if(d.main&&b.genre!==d.main)out.push('genre → '+d.main);
  const add=d.add.filter(x=>!b.subgenres.includes(x)),rem=d.remove.filter(x=>b.subgenres.includes(x));
  if(add.length)out.push('+ '+add.join(', '));
  if(rem.length)out.push('− '+rem.join(', '));
  const ta=d.tadd.filter(x=>!(b.tags||[]).includes(x)),tr=d.tremove.filter(x=>(b.tags||[]).includes(x));
  if(ta.length)out.push('+ tag '+ta.join(', '));
  if(tr.length)out.push('− tag '+tr.join(', '));
  return out.join(' · ');
}

/* ---------- cover: crop to 2:3 and shrink to 300x450 webp ---------- */
function coverToWebp(file){
  return new Promise((res,rej)=>{
    const url=URL.createObjectURL(file),im=new Image();
    im.onload=()=>{
      try{
        const W=300,H=450,c=document.createElement('canvas');c.width=W;c.height=H;const x=c.getContext('2d');
        const r=Math.max(W/im.naturalWidth,H/im.naturalHeight),w=im.naturalWidth*r,h=im.naturalHeight*r;
        x.drawImage(im,(W-w)/2,(H-h)/2,w,h);
        c.toBlob(b=>{URL.revokeObjectURL(url);if(!b)return rej(new Error('This browser could not make a webp image'));
          const fr=new FileReader();fr.onload=()=>res(fr.result);fr.readAsDataURL(b)},'image/webp',0.86);
      }catch(e){rej(e)}
    };
    im.onerror=()=>{URL.revokeObjectURL(url);rej(new Error('That file is not an image this browser can read'))};
    im.src=url;
  });
}

/* ---------- GitHub: one commit for everything ---------- */
async function gh(path,opt={}){
  const r=await fetch(API+path,{method:opt.method||'GET',cache:'no-store',headers:Object.assign({'Authorization':'Bearer '+OWN.token,'Accept':opt.accept||'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},opt.body?{'Content-Type':'application/json'}:{}),body:opt.body?JSON.stringify(opt.body):undefined});
  if(!r.ok){
    let m='';try{m=(await r.json()).message||''}catch(e){}
    if(r.status===401)throw new Error('GitHub rejected the token (expired or wrong). Paste a new one in Settings.');
    if(r.status===403)throw new Error('GitHub refused the request. Check that the token allows Contents read and write for '+REPO+'. '+m);
    if(r.status===404)throw new Error('GitHub could not find '+REPO+' on branch "'+(OWN.branch||'main')+'", or the token cannot see it.');
    throw new Error('GitHub error '+r.status+(m?': '+m:''));
  }
  return opt.accept&&opt.accept.includes('raw')?r.text():r.json();
}
async function commitOps(ops,covers,message,removes){
  const br=OWN.branch||'main';
  const ref=await gh('/repos/'+REPO+'/git/ref/heads/'+encodeURIComponent(br));
  const head=ref.object.sha;
  const cm=await gh('/repos/'+REPO+'/git/commits/'+head);
  const raw=await gh('/repos/'+REPO+'/contents/data/library.json?ref='+encodeURIComponent(br),{accept:'application/vnd.github.raw+json'});
  const fresh=JSON.parse(raw);
  const next=applyOps(fresh,ops);next.rev=(fresh.rev||0)+1;
  const entries=[];
  const lib=await gh('/repos/'+REPO+'/git/blobs',{method:'POST',body:{content:serialize(next),encoding:'utf-8'}});
  entries.push({path:'data/library.json',mode:'100644',type:'blob',sha:lib.sha});
  for(const c of covers){
    const b=await gh('/repos/'+REPO+'/git/blobs',{method:'POST',body:{content:c.dataUrl.split(',')[1],encoding:'base64'}});
    entries.push({path:c.path,mode:'100644',type:'blob',sha:b.sha});
  }
  (removes||[]).forEach(path=>entries.push({path,mode:'100644',type:'blob',sha:null}));
  const tree=await gh('/repos/'+REPO+'/git/trees',{method:'POST',body:{base_tree:cm.tree.sha,tree:entries}});
  const commit=await gh('/repos/'+REPO+'/git/commits',{method:'POST',body:{message,tree:tree.sha,parents:[head]}});
  await gh('/repos/'+REPO+'/git/refs/heads/'+encodeURIComponent(br),{method:'PATCH',body:{sha:commit.sha}});
  return {db:next,sha:commit.sha};
}
function keepLocal(db,covers,removeIds){
  try{
    localStorage.setItem('rr-local',JSON.stringify({rev:db.rev||0,db,fp:window.RR_FP}));
    const m=JSON.parse(localStorage.getItem('rr-local-covers')||'{}');covers.forEach(c=>{m[c.id]=c.dataUrl});(removeIds||[]).forEach(i=>{delete m[i]});
    localStorage.setItem('rr-local-covers',JSON.stringify(m));
  }catch(e){throw new Error('This browser could not keep a local copy ('+e.message+'). The commit is safe; refresh after a minute.')}
}
async function save(ops,covers,message,removes){
  const rids=(removes||[]).map(p=>p.replace(/^covers\//,'').replace(/\.webp$/,''));
  if(OWN.dry){
    const base=(()=>{try{const L=JSON.parse(localStorage.getItem('rr-local')||'null');return L&&L.rev>(DB.rev||0)?L.db:DB}catch(e){return DB}})();
    const next=applyOps(base,ops);next.rev=(base.rev||0)+1;keepLocal(next,covers,rids);return {db:next,sha:null};
  }
  const r=await commitOps(ops,covers,message,removes);keepLocal(r.db,covers,rids);return r;
}

/* ---------- styles ---------- */
const css=document.createElement('style');
css.textContent=`
#rrmask{position:fixed;inset:0;z-index:80;background:rgba(4,12,16,.72);display:none;align-items:flex-start;justify-content:center;overflow:auto;padding:24px 12px}
#rrmask.on{display:flex}
#rrform{width:min(760px,100%);background:#142C35;border:1px solid rgba(244,230,202,.2);border-radius:16px;padding:22px;color:#F4E6CA;font:15px/1.45 var(--sans,sans-serif)}
#rrform h2{font-size:26px;margin:0 0 14px}
#rrform .g{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px 14px}
#rrform label{display:block;font-size:13px;color:#9db0b5;margin:0 0 4px}
#rrform input[type=text],#rrform input[type=number],#rrform select,#rrform textarea{width:100%;box-sizing:border-box;background:#0d1d24;color:#F4E6CA;border:1px solid rgba(244,230,202,.25);border-radius:10px;padding:9px 11px;font:15px var(--sans,sans-serif)}
#rrform textarea{min-height:96px;resize:vertical}
#rrform .full{grid-column:1/-1}
#rrform .chips{display:flex;flex-wrap:wrap;gap:6px}
#rrform .chips button{border:1px solid rgba(244,230,202,.3);background:transparent;color:#F4E6CA;border-radius:999px;padding:6px 12px;font:13px var(--sans,sans-serif);cursor:pointer}
#rrform .chips button[aria-pressed=true]{background:#E8B85F;color:#08131B;border-color:#E8B85F;font-weight:600}
#rrform .warn{color:#E8B85F;font-size:13px;margin-top:4px}
#rrform .err{color:#ff9b8a;font-size:14px;margin:12px 0 0;white-space:pre-wrap}
#rrform .bulk{border:1px solid rgba(244,230,202,.2);border-radius:12px;padding:12px 14px;margin-top:14px}
#rrform .bulk label{display:flex;gap:9px;align-items:center;color:#F4E6CA;font-size:14px;margin:4px 0}
#rrform .bulk ul{list-style:none;margin:8px 0 0;padding:0;max-height:200px;overflow:auto;font-size:13px}
#rrform .bulk li{display:flex;gap:8px;padding:3px 0;align-items:flex-start}
#rrform .bulk li small{color:#9db0b5}
#rrform .act{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}
#rrform .cvrow{display:flex;gap:14px;align-items:flex-start}
#rrform .cvrow img{width:80px;height:120px;object-fit:cover;border-radius:6px;background:#0d1d24;border:1px solid rgba(244,230,202,.2)}
#stars{position:relative;display:inline-block;font-size:34px;line-height:1;letter-spacing:2px;cursor:pointer;touch-action:none}
#stars .sb{color:#31505a}#stars .sf{position:absolute;left:0;top:0;overflow:hidden;white-space:nowrap;color:#E8B85F;pointer-events:none}
#stars .sz{position:absolute;inset:0;display:flex}#stars .sz i{flex:1}
#stars:focus-visible{outline:2px solid #E8B85F;outline-offset:4px;border-radius:6px}
#rrform .hint{font-size:12px;color:#9db0b5}
`;
document.head.appendChild(css);

/* ---------- form ---------- */
let F=null;
function tagVocab(){return (DB.genres.tags||[]).map(t=>t.name)}   // current form state
function authorsList(){return [...new Set(DB.books.map(b=>b.author))].sort()}
function seriesList(){return [...new Set(DB.books.map(b=>b.series).filter(Boolean))].sort()}
function subVocab(main){return DB.genres.sub.filter(s=>!s.for||s.for.includes(main)).map(s=>s.name)}
function blank(){return {id:'n'+Date.now().toString(36),title:'',author:'',series:'',seriesNum:'',status:'to-read',rating:0,pages:0,pubYear:0,dateRead:'',dateAdded:today(),review:'',summary:'',genre:DB.genres.main[0].name,subgenres:[],tags:[],explicit:false}}
function openForm(id){
  const isNew=!id,orig=isNew?blank():clone(DBX[id]);
  orig.tags=orig.tags||[];F={isNew,orig,cur:clone(orig),cover:null,newMain:null,newSub:[],newTag:[],bulkSeries:false,bulkAuthor:false,excluded:new Set(),err:''};
  F.cur.review=(F.cur.review||'').replace(/<br\s*\/?>/gi,'\n');F.origReview=F.cur.review;
  render();q('#rrmask').classList.add('on');
}
function closeForm(){q('#rrmask').classList.remove('on');F=null}
function field(l,html,cls){return `<div class="${cls||''}"><label>${l}</label>${html}</div>`}
function render(){
  const c=F.cur,mains=DB.genres.main.map(m=>m.name).concat(F.newMain?[F.newMain.name]:[]);
  const vocab=[...new Set(subVocab(c.genre).concat(F.newSub.map(s=>s.name),c.subgenres))];
  const nS=c.subgenres.length;
  const aSim=similarName(c.author,authorsList()),sSim=similarName(c.series,seriesList());
  const coverSrc=F.cover||'';const oldCv=(!F.cover&&!F.isNew&&typeof byId!=='undefined'&&byId[c.id])?cv(byId[c.id]):'';
  q('#rrform').innerHTML=`
  <h2>${F.isNew?'Add a book':'Edit book'}</h2>
  <div class="g">
   ${field('Title','<input type="text" id="f_title" value="'+E(c.title)+'">','full')}
   ${field('Author','<input type="text" id="f_author" list="dl_au" value="'+E(c.author)+'"><datalist id="dl_au">'+authorsList().map(a=>'<option value="'+E(a)+'">').join('')+'</datalist>'+(aSim?'<div class="warn">Similar to “'+E(aSim)+'”. <a href="#" data-use="author" data-v="'+E(aSim)+'" style="color:#E8B85F">Use that spelling</a></div>':''))}
   ${field('Series','<input type="text" id="f_series" list="dl_se" value="'+E(c.series)+'"><datalist id="dl_se">'+seriesList().map(a=>'<option value="'+E(a)+'">').join('')+'</datalist>'+(sSim?'<div class="warn">Similar to “'+E(sSim)+'”. <a href="#" data-use="series" data-v="'+E(sSim)+'" style="color:#E8B85F">Use that spelling</a></div>':''))}
   ${field('Number in series','<input type="text" id="f_sn" value="'+E(c.seriesNum)+'">')}
   ${field('Shelf','<select id="f_status">'+STATUS.map(s=>'<option value="'+s[0]+'"'+(c.status===s[0]?' selected':'')+'>'+s[1]+'</option>').join('')+'</select>')}
   ${field('Rating','<div id="stars" role="slider" tabindex="0" aria-label="Rating" aria-valuemin="0" aria-valuemax="5" aria-valuenow="'+c.rating+'" aria-valuetext="'+(c.rating?c.rating+' out of 5':'Unrated')+'"><span class="sb">★★★★★</span><span class="sf" style="width:'+c.rating/5*100+'%">★★★★★</span><span class="sz">'+[...Array(20).keys()].map(i=>'<i data-v="'+(i+1)/4+'"></i>').join('')+'</span></div><div class="hint"><span id="rtxt">'+(c.rating?c.rating+' out of 5':'Unrated')+'</span> · tap or click a star (quarter steps) · <a href="#" id="rclear" style="color:#E8B85F">Clear</a></div>')}
   ${field('Date finished (YYYY-MM-DD)','<div style="display:flex;gap:8px"><input type="text" id="f_dr" placeholder="2026-11-14" value="'+E(c.dateRead)+'"><button class="btn ghost" id="f_today" type="button" style="flex:none">Today</button></div>')}
   ${field('Date added (YYYY-MM-DD)','<input type="text" id="f_da" value="'+E(c.dateAdded)+'">')}
   ${field('Pages','<input type="number" id="f_pages" min="0" value="'+E(c.pages)+'">')}
   ${field('Published (year)','<input type="number" id="f_year" min="0" value="'+E(c.pubYear)+'">')}
   <div class="full"><label>Main genre</label>
    <select id="f_genre">${mains.map(m=>'<option'+(c.genre===m?' selected':'')+'>'+E(m)+'</option>').join('')}<option value="__new">New genre…</option></select>
    <div id="newmain" style="display:none;margin-top:8px;gap:8px;align-items:center"><input type="text" id="nm_name" placeholder="Genre name" style="max-width:260px"> <input type="color" id="nm_color" value="#5B6B8C" aria-label="Genre color" style="height:36px;width:48px"> <button class="btn" id="nm_ok" type="button">Add genre</button></div></div>
   <div class="full"><label>Subgenres (${nS} chosen; 3 is the usual limit, ${CAP} the most)</label>
    <div class="chips" id="subs">${vocab.map(s=>'<button type="button" data-s="'+E(s)+'" aria-pressed="'+c.subgenres.includes(s)+'">'+E(s)+'</button>').join('')}</div>
    <div style="margin-top:8px;display:flex;gap:8px"><input type="text" id="newsub" placeholder="Add a new subgenre" style="max-width:260px"><button class="btn" id="newsub_ok" type="button">Add</button></div>
    ${nS>3?'<div class="warn">More than 3 subgenres. Allowed, but BISAC and most retailers stop at 3.</div>':''}</div>
   <div class="full"><label>Tags (${(c.tags||[]).length} chosen, up to ${TCAP}): tropes and traits</label>
    <div class="chips" id="tgs">${[...new Set(tagVocab().concat(F.newTag,c.tags||[]))].map(s=>'<button type="button" data-t2="'+E(s)+'" aria-pressed="'+(c.tags||[]).includes(s)+'">'+E(s)+'</button>').join('')}</div>
    <div style="margin-top:8px;display:flex;gap:8px"><input type="text" id="newtag" placeholder="Add a new tag" style="max-width:260px"><button class="btn" id="newtag_ok" type="button">Add</button></div></div>
   <div class="full"><label>Cover${F.isNew?' (required)':''}</label><div class="cvrow">${coverSrc?'<img id="cvprev" alt="Cover preview" src="'+E(coverSrc)+'">':(oldCv?'<div style="width:80px;flex:none">'+oldCv+'</div>':'<img id="cvprev" alt="No cover yet">')}<div><input type="file" id="f_cover" accept="image/*"><div class="hint">Cropped to 2:3 and shrunk to 300 × 450 webp in your browser.</div></div></div></div>
   ${field('Summary'+(F.isNew?' (required: use the publisher’s description)':''),'<textarea id="f_sum">'+E(c.summary)+'</textarea>','full')}
   ${field('My review','<textarea id="f_rv">'+E(c.review)+'</textarea>','full')}
   <div class="full"><label style="display:flex;gap:8px;align-items:center;color:#F4E6CA"><input type="checkbox" id="f_x" ${c.explicit?'checked':''}> Explicit content</label></div>
  </div>
  ${F.isNew?'':bulkHtml()}
  <div class="err" id="rrerr">${E(F.err)}</div>
  <div class="act">${F.isNew?'':(F.confirmDel?'<span style="margin-right:auto;align-self:center;color:#ff9b8a">Delete “'+E(c.title)+'” for good? <button class="btn ghost" id="rr_del_no" type="button">Keep it</button> <button class="btn" id="rr_del_yes" type="button" style="background:#B03A2E;border-color:#B03A2E;color:#fff">Yes, delete</button></span>':'<button class="btn ghost" id="rr_del" type="button" style="margin-right:auto;color:#ff9b8a;border-color:rgba(255,155,138,.5)">Delete this book</button>')}<button class="btn ghost" id="rr_cancel" type="button">Cancel</button><button class="btn" id="rr_save" type="button">${OWN.dry?'Save (dry run, this browser only)':'Save to GitHub'}</button></div>`;
  wire();
}
function bulkHtml(){
  const d=genreDiff(F.orig,F.cur),empty=diffIsEmpty(d);
  const hasSer=!!F.orig.series;
  let list='';
  if((F.bulkSeries||F.bulkAuthor)&&!empty){
    const ts=bulkTargets(F.orig,F.bulkSeries,F.bulkAuthor).map(b=>({b,t:describe(b,d)})).filter(x=>x.t);
    F.targets=ts;
    list='<div style="margin-top:8px"><b>This will change '+ts.filter(x=>!F.excluded.has(x.b.id)).length+' other book'+(ts.length===1?'':'s')+'</b> <small>(untick any to skip)</small></div><ul>'+
      ts.map(x=>'<li><input type="checkbox" data-t="'+E(x.b.id)+'" '+(F.excluded.has(x.b.id)?'':'checked')+'><span>'+E(x.b.title)+' <small>by '+E(x.b.author)+' — '+E(x.t)+'</small></span></li>').join('')+'</ul>';
    if(!ts.length)list='<div class="hint" style="margin-top:8px">No other books would change.</div>';
  }else F.targets=[];
  return `<div class="bulk"><b>Spread genre changes to other books</b> <span class="hint">(only genre, subgenres and tags; off by default; resets after saving)</span>
   <label><input type="checkbox" id="b_ser" ${F.bulkSeries?'checked':''} ${hasSer?'':'disabled'}> Apply to the whole series${hasSer?' “'+E(F.orig.series)+'”':' (this book has no series)'}</label>
   <label><input type="checkbox" id="b_au" ${F.bulkAuthor?'checked':''}> Apply to everything by ${E(F.orig.author||'this author')}</label>
   ${(F.bulkSeries||F.bulkAuthor)&&empty?'<div class="hint">Change the genre, subgenres or tags above and the affected books will be listed here.</div>':''}${list}</div>`;
}
function readFields(){
  const c=F.cur,v=id=>q(id).value;
  c.title=v('#f_title').trim();c.author=v('#f_author').trim();c.series=v('#f_series').trim();c.seriesNum=v('#f_sn').trim();
  c.status=v('#f_status');c.dateRead=v('#f_dr').trim();c.dateAdded=v('#f_da').trim();
  c.pages=+v('#f_pages')||0;c.pubYear=+v('#f_year')||0;
  c.summary=v('#f_sum').trim();c.review=v('#f_rv');c.explicit=q('#f_x').checked;
  const g=v('#f_genre');if(g!=='__new')c.genre=g;
}
function wire(){
  const keep=fn=>e=>{readFields();fn(e);};
  qa('[data-use]').forEach(a=>a.onclick=keep(e=>{e.preventDefault();F.cur[a.dataset.use]=a.dataset.v;render()}));
  ['#f_author','#f_series'].forEach(id=>{q(id).onchange=keep(()=>render())});
  q('#f_genre').onchange=e=>{readFields();if(e.target.value==='__new'){q('#newmain').style.display='flex';return}
    F.cur.genre=e.target.value;const ok=new Set(subVocab(F.cur.genre));render()};
  q('#nm_ok').onclick=()=>{const n=q('#nm_name').value.trim();if(!n)return;readFields();
    if(DB.genres.main.some(m=>m.name.toLowerCase()===n.toLowerCase())){F.err='That genre already exists.';render();return}
    F.newMain={name:n,color:q('#nm_color').value};F.cur.genre=n;F.err='';render()};
  qa('#subs button').forEach(b=>b.onclick=keep(()=>{const s=b.dataset.s,a=F.cur.subgenres;
    if(a.includes(s))F.cur.subgenres=a.filter(x=>x!==s);else if(a.length>=CAP){F.err='The most subgenres a book can have is '+CAP+'.';}else{F.cur.subgenres=a.concat(s);F.err=''}render()}));
  q('#newsub_ok').onclick=keep(()=>{const n=q('#newsub').value.trim();if(!n)return;
    const have=DB.genres.sub.find(s=>s.name.toLowerCase()===n.toLowerCase());const name=have?have.name:n;
    if(!have&&!F.newSub.some(s=>s.name===name))F.newSub.push({name,source:'reader',for:[F.cur.genre]});
    if(!F.cur.subgenres.includes(name)){if(F.cur.subgenres.length>=CAP)F.err='The most subgenres a book can have is '+CAP+'.';else F.cur.subgenres.push(name)}render()});
  qa('#tgs button').forEach(b=>b.onclick=keep(()=>{const s=b.dataset.t2,a=F.cur.tags||[];
    if(a.includes(s))F.cur.tags=a.filter(x=>x!==s);else if(a.length>=TCAP){F.err='The most tags a book can have is '+TCAP+'.'}else{F.cur.tags=a.concat(s);F.err=''}render()}));
  q('#newtag_ok').onclick=keep(()=>{const n=q('#newtag').value.trim();if(!n)return;
    const have=tagVocab().find(s=>s.toLowerCase()===n.toLowerCase());const name=have||n;
    if(!have&&!F.newTag.includes(name))F.newTag.push(name);
    const a=F.cur.tags||[];if(!a.includes(name)){if(a.length>=TCAP)F.err='The most tags a book can have is '+TCAP+'.';else F.cur.tags=a.concat(name)}render()});
  q('#f_cover').onchange=async e=>{const f=e.target.files[0];if(!f)return;readFields();
    try{F.cover=await coverToWebp(f);F.err=''}catch(x){F.err=x.message}render()};
  const bs=q('#b_ser'),ba=q('#b_au');
  if(bs)bs.onchange=keep(()=>{F.bulkSeries=bs.checked;F.excluded=new Set();render()});
  if(ba)ba.onchange=keep(()=>{F.bulkAuthor=ba.checked;F.excluded=new Set();render()});
  qa('[data-t]').forEach(cb=>cb.onchange=keep(()=>{cb.checked?F.excluded.delete(cb.dataset.t):F.excluded.add(cb.dataset.t);render()}));
  const st=q('#stars'),show=r=>{q('.sf',st).style.width=r/5*100+'%';q('#rtxt').textContent=r?r+' out of 5':'Unrated'};
  const setR=r=>{F.cur.rating=Math.max(0,Math.min(5,r));st.setAttribute('aria-valuenow',F.cur.rating);show(F.cur.rating)};
  qa('i[data-v]',st).forEach(i=>{i.onmouseenter=()=>show(+i.dataset.v);i.onclick=()=>setR(+i.dataset.v)});
  st.onmouseleave=()=>show(F.cur.rating);
  st.onkeydown=e=>{const k={ArrowRight:.25,ArrowUp:.25,ArrowLeft:-.25,ArrowDown:-.25}[e.key];if(k){e.preventDefault();setR(F.cur.rating+k)}else if(e.key==='Home'){e.preventDefault();setR(0)}else if(e.key==='End'){e.preventDefault();setR(5)}};
  q('#rclear').onclick=e=>{e.preventDefault();setR(0)};
  q('#f_today').onclick=()=>{q('#f_dr').value=today()};
  const d1=q('#rr_del'),d2=q('#rr_del_no'),d3=q('#rr_del_yes');
  if(d1)d1.onclick=keep(()=>{F.confirmDel=true;render()});if(d2)d2.onclick=keep(()=>{F.confirmDel=false;render()});if(d3)d3.onclick=doDelete;
  q('#rr_cancel').onclick=closeForm;q('#rr_save').onclick=doSave;
}
function validate(){
  const c=F.cur,errs=[];
  if(!c.title)errs.push('Add a title.');if(!c.author)errs.push('Add an author.');
  if(c.dateRead&&!/^\d{4}-\d{2}-\d{2}$/.test(c.dateRead))errs.push('Date finished must look like 2026-11-14, or be empty.');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(c.dateAdded))errs.push('Date added must look like 2026-11-14.');
  if(c.status==='read'&&!c.dateRead)errs.push('A book on the Read shelf needs a finished date (use today if unsure).');
  if(F.isNew){
    if(!F.cover)errs.push('A real cover is required before a new book can be saved.');
    if(c.summary.length<60)errs.push('Add the publisher’s summary (at least a couple of sentences). A book is not saved without one.');
    if(DB.books.some(b=>normName(b.title)===normName(c.title)&&normName(b.author)===normName(c.author)))errs.push('This title by this author is already in the library.');
  }
  if(c.subgenres.length>CAP)errs.push('Too many subgenres.');
  return errs;
}
async function doSave(){
  readFields();F.err='';
  const errs=validate();if(errs.length){F.err=errs.join('\n');render();return}
  const btn=q('#rr_save');btn.disabled=true;btn.textContent='Saving…';
  try{
    const c=F.cur,o=F.orig,ops=[],covers=[];
    const reg={op:'registry',main:F.newMain?[F.newMain]:[],sub:F.newSub.filter(s=>c.subgenres.includes(s.name)),tags:F.newTag.filter(t=>(c.tags||[]).includes(t)).map(name=>({name,source:'reader'}))};
    if(reg.main.length||reg.sub.length||reg.tags.length)ops.push(reg);
    const rec=b=>b;
    if(F.isNew){
      const book={id:c.id,title:c.title,author:c.author,series:c.series,seriesNum:c.seriesNum,status:c.status,rating:c.rating,pages:c.pages,pubYear:c.pubYear,dateRead:c.dateRead,dateAdded:c.dateAdded,review:c.review,summary:c.summary,genre:c.genre,subgenres:c.subgenres,tags:c.tags||[],explicit:c.explicit,cover:{file:'covers/'+c.id+'.webp'}};
      covers.push({id:c.id,path:'covers/'+c.id+'.webp',dataUrl:F.cover});
      ops.push({op:'add',book});
    }else{
      const set={};
      ['title','author','series','seriesNum','status','rating','pages','pubYear','dateRead','dateAdded','summary','genre','explicit'].forEach(k=>{if(c[k]!==o[k])set[k]=c[k]});
      if(c.review!==F.origReview)set.review=c.review;
      if(JSON.stringify(c.subgenres)!==JSON.stringify(o.subgenres))set.subgenres=c.subgenres;
      if(JSON.stringify(c.tags||[])!==JSON.stringify(o.tags||[]))set.tags=c.tags||[];
      if(F.cover){set.cover={file:'covers/'+c.id+'.webp'};delete set.noCover;covers.push({id:c.id,path:'covers/'+c.id+'.webp',dataUrl:F.cover})}
      if(Object.keys(set).length)ops.push({op:'update',id:c.id,set});
      const d=genreDiff(o,c);let n=0;
      if((F.bulkSeries||F.bulkAuthor)&&!diffIsEmpty(d)){
        (F.targets||[]).filter(x=>!F.excluded.has(x.b.id)).forEach(x=>{
          const set2={};if(d.main)set2.genre=d.main;
          ops.push({op:'update',id:x.b.id,set:set2,addSub:d.add,removeSub:d.remove,addTag:d.tadd,removeTag:d.tremove});n++});
      }
      if(!ops.length){F.err='Nothing has changed.';render();return}
      F.bulkN=n;
    }
    const msg=(F.isNew?'Add: ':'Edit: ')+c.title+(F.bulkN?' (+'+F.bulkN+' related books)':'');
    await save(ops,covers,msg);
    toast(OWN.dry?'Saved in this browser (dry run).':'Saved to GitHub. Visitors see it in about a minute.');
    closeForm();setTimeout(()=>location.reload(),600);
  }catch(e){F.err=e.message;render()}
}

async function doDelete(){
  F.err='';const c=F.orig,b=DBX[c.id]||c;
  q('#rr_del_yes').disabled=true;q('#rr_del_yes').textContent='Deleting…';
  try{
    const removes=b.cover&&b.cover.file?[b.cover.file]:[];
    await save([{op:'delete',id:c.id}],[],'Delete: '+c.title,removes);
    toast(OWN.dry?'Deleted in this browser (practice mode).':'Deleted. It stays in the GitHub history if you ever need it back.');
    closeForm();setTimeout(()=>location.reload(),600);
  }catch(e){F.err=e.message;F.confirmDel=false;render()}
}
/* ---------- chrome: form mask, edit button in the drawer (Add a book lives in Settings) ---------- */
function bar(){
  const m=document.createElement('div');m.id='rrmask';m.innerHTML='<div id="rrform" role="dialog" aria-modal="true" aria-label="Edit book"></div>';
  document.body.appendChild(m);
  m.addEventListener('mousedown',e=>{if(e.target===m)closeForm()});
  addEventListener('keydown',e=>{if(e.key==='Escape'&&F)closeForm()});
}
const od=window.openDetail;
window.openDetail=function(id,opt){
  od(id,opt);
  const top=q('#drawer .dtop>div:last-child');
  if(top&&DBX[id]){const b=document.createElement('div');b.style.margin='10px 0 2px';b.innerHTML='<button class="btn ghost" id="rr_edit" type="button">Edit this book</button>';top.appendChild(b);q('#rr_edit').onclick=()=>{closeDrawer(true);openForm(id)}}
};
bar();
window.RR_EDITOR={applyOps,serialize,genreDiff,bulkTargets,similarName,describe,openForm,coverToWebp,commitOps,save};
})();
