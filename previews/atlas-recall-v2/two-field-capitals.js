function atlasTwoFieldBoot(){
  if(window.__atlasTwoFieldV1)return;
  window.__atlasTwoFieldV1=true;

  try{
    const freePanel=document.getElementById('freePanel');
    const oldCapitalPanel=document.getElementById('capitalPanel');
    const answerInput=document.getElementById('answerInput');
    const answerShell=document.getElementById('answerShell');
    const answerLabel=freePanel&&freePanel.querySelector('.answer-label');
    const matchCue=document.getElementById('matchCue');
    const feedback=document.getElementById('feedback');
    if(!freePanel||!answerInput||!answerShell||!answerLabel||!matchCue||!feedback){
      throw new Error('Country entry controls were not found.');
    }

    document.body.dataset.build='two-field-capitals-v1';
    const style=document.createElement('style');
    style.id='twoFieldCapitalStyles';
    style.textContent=`
      #capitalPanel{display:none!important}
      #freePanel.hidden{display:block!important}
      .dual-entry-grid{display:grid;grid-template-columns:minmax(0,1.38fr) minmax(280px,.92fr);gap:10px;align-items:start}
      .dual-entry-grid.capital-off{grid-template-columns:1fr}
      .entry-pane{min-width:0}
      .entry-pane .answer-label{min-height:18px;margin-bottom:5px}
      .entry-pane .answer-label strong{font-size:.84rem}
      .capital-bonus-note{color:var(--warning);font-size:.56rem;font-weight:900;letter-spacing:.035em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .capital-inline-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px}
      .capital-inline-row .answer-shell input{padding-top:13px;padding-bottom:13px;font-size:.98rem}
      .capital-skip-inline{min-width:62px;padding-inline:8px;font-size:.68rem}
      #capitalAnyCue,#capitalAnyFeedback{font-size:.64rem}
      #capitalAnyFeedback{min-height:37px}
      .capital-entry-pane.capital-hit{animation:capital-pane-hit .5s ease}
      @keyframes capital-pane-hit{45%{filter:drop-shadow(0 0 13px color-mix(in srgb,var(--success) 55%,transparent));transform:translateY(-1px)}}
      @media(max-width:980px){.dual-entry-grid{grid-template-columns:minmax(0,1.2fr) minmax(245px,.8fr);gap:8px}.capital-bonus-note{font-size:.52rem}}
      @media(max-width:760px){.dual-entry-grid{grid-template-columns:1fr}.capital-inline-row .answer-shell input{font-size:1rem}}
    `;
    document.head.appendChild(style);

    const countryPane=document.createElement('section');
    countryPane.className='entry-pane country-entry-pane';
    const countryStrong=answerLabel.querySelector('strong');
    if(countryStrong)countryStrong.textContent='Country';
    answerInput.placeholder='Type any country';
    countryPane.append(answerLabel,answerShell,matchCue,feedback);

    const capitalPane=document.createElement('section');
    capitalPane.className='entry-pane capital-entry-pane';
    capitalPane.id='alwaysCapitalPane';
    capitalPane.innerHTML=`
      <div class="answer-label"><strong>Capital</strong><span class="capital-bonus-note" id="capitalTargetBonus">Any order · +25</span></div>
      <div class="capital-inline-row">
        <div class="answer-shell" id="anyCapitalShell"><input id="anyCapitalInput" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Type any capital"></div>
        <button class="btn capital-skip-inline" id="anyCapitalSkip" type="button">Skip ↩</button>
      </div>
      <div class="match-cue" id="capitalAnyCue">+25 each · +50 when its country is also recalled.</div>
      <div class="feedback" id="capitalAnyFeedback" aria-live="polite">Tab or Skip returns to countries.</div>
    `;

    const grid=document.createElement('div');
    grid.className='dual-entry-grid';
    grid.append(countryPane,capitalPane);
    freePanel.replaceChildren(grid);

    const capitalInput=document.getElementById('anyCapitalInput');
    const capitalShell=document.getElementById('anyCapitalShell');
    const capitalSkip=document.getElementById('anyCapitalSkip');
    const capitalCue=document.getElementById('capitalAnyCue');
    const capitalFeedback=document.getElementById('capitalAnyFeedback');
    const capitalTarget=document.getElementById('capitalTargetBonus');
    const modeSelect=document.getElementById('modeSelect');
    const startBtn=document.getElementById('startBtn');
    const followBtn=document.getElementById('followBtn');
    const zoomReset=document.getElementById('zoomReset');

    const countryById=new Map((Array.isArray(COUNTRIES)?COUNTRIES:[]).map(country=>[country.id,country]));
    const countryName=id=>countryById.get(id)?.name||String(id||'').replace(/-/g,' ').replace(/\b\w/g,char=>char.toUpperCase());

    const capitalModeSelect=[...document.querySelectorAll('select')].find(select=>{
      const hay=(select.id+' '+select.name+' '+[...select.options].map(option=>option.textContent).join(' ')).toLowerCase();
      return hay.includes('capital');
    });
    const capitalsEnabled=()=>{
      if(!capitalModeSelect)return true;
      const option=capitalModeSelect.options[capitalModeSelect.selectedIndex];
      const text=(capitalModeSelect.value+' '+(option?option.textContent:'')).toLowerCase();
      return !/(countries only|without capital|off|none|disabled)/.test(text);
    };

    function ensureCapitalState(){
      if(!(state.capitalAnswered instanceof Set))state.capitalAnswered=new Set(state.capitalAnswered||[]);
      if(!(state.capitalPairs instanceof Set))state.capitalPairs=new Set(state.capitalPairs||[]);
      if(!Number.isFinite(state.capitalsCorrect))state.capitalsCorrect=state.capitalAnswered.size;
      if(!('latestCapitalCountry' in state))state.latestCapitalCountry=null;
      state.capitalPending=null;
    }

    function setCapitalFeedback(text,kind=''){
      capitalFeedback.textContent=text;
      capitalFeedback.className='feedback'+(kind?' '+kind:'');
    }
    function setCapitalCue(text,kind=''){
      capitalCue.textContent=text;
      capitalCue.className='match-cue'+(kind?' '+kind:'');
    }

    function syncCapitalAvailability(){
      ensureCapitalState();
      const hidden=(state.mode==='ladder')||!capitalsEnabled();
      capitalPane.hidden=hidden;
      grid.classList.toggle('capital-off',hidden);
      capitalInput.disabled=hidden||state.paused||state.ended;
      capitalSkip.disabled=hidden||state.paused||state.ended;
      if(oldCapitalPanel){oldCapitalPanel.hidden=true;oldCapitalPanel.classList.remove('active')}
      if(!hidden)freePanel.classList.remove('hidden');
    }

    function updateCapitalPrompt(){
      ensureCapitalState();
      const id=state.latestCapitalCountry;
      if(id&&!state.capitalAnswered.has(id)){
        const name=countryName(id);
        capitalTarget.textContent='Capital of '+name+' · +75 pair';
        capitalInput.placeholder=name+' capital — or any capital';
        setCapitalCue('Any capital counts; '+name+' completes the full +75 pair.','');
      }else{
        capitalTarget.textContent='Any order · +25';
        capitalInput.placeholder='Type any capital';
        setCapitalCue('+25 each · +50 when its country is also recalled.','');
      }
    }

    function classifyCapital(raw){
      const value=String(raw||'').trim();
      if(!value)return{type:'empty'};
      const hits=[];
      for(const [id,data] of Object.entries(CAPITALS||{})){
        let result=null;
        try{result=capitalMatch(value,data)}catch(error){result=null}
        if(result&&result.ok)hits.push({id,data,result});
      }
      if(!hits.length)return{type:'none'};
      const exactish=hits.filter(hit=>hit.result.match!=='fuzzy');
      const source=exactish.length?exactish:hits;
      const unique=[...new Map(source.map(hit=>[hit.id,hit])).values()];
      if(unique.length!==1)return{type:'ambiguous',matches:unique};
      const hit=unique[0];
      if(state.capitalAnswered.has(hit.id))return{type:'duplicate',...hit};
      return{type:'accept',...hit};
    }

    function maybeAwardPair(id){
      ensureCapitalState();
      if(state.guessed instanceof Set&&state.guessed.has(id)&&state.capitalAnswered.has(id)&&!state.capitalPairs.has(id)){
        state.capitalPairs.add(id);
        state.score+=50;
        return 50;
      }
      return 0;
    }

    function safelyUpdateAll(){
      try{updateAll()}catch(error){}
      syncCapitalAvailability();
    }

    function showCapitalSuccess(match,total,pair){
      const capitalName=match.data.name||capitalInput.value.trim();
      const name=countryName(match.id);
      const suffix=pair?' · pair complete':' · pair bonus waits for '+name;
      setCapitalFeedback(capitalName+' — '+name+' · +'+total+suffix,'good');
      setCapitalCue(pair?'Country + capital complete.':'Capital counted in any order.','ready');
      capitalPane.classList.remove('capital-hit');
      void capitalPane.offsetWidth;
      capitalPane.classList.add('capital-hit');
      try{if(typeof playSfx==='function')playSfx('success',pair?1:.8)}catch(error){}
      try{if(typeof showMilestone==='function')showMilestone((capitalName+' · +'+total+(pair?' PAIR BONUS':' CAPITAL')).toUpperCase())}catch(error){}
    }

    function submitAnyCapital(automatic=false){
      ensureCapitalState();
      if(state.paused||state.ended)return;
      const raw=capitalInput.value.trim();
      if(!raw){skipCapital();return}
      if(!state.active){
        const saved=capitalInput.value;
        try{startRound({preserveInput:true})}catch(error){try{startRound()}catch(inner){}}
        capitalInput.value=saved;
        capitalInput.focus();
      }
      const match=classifyCapital(raw);
      if(match.type==='accept'){
        state.capitalAnswered.add(match.id);
        state.capitalsCorrect=state.capitalAnswered.size;
        state.score+=25;
        const pair=maybeAwardPair(match.id);
        const total=25+pair;
        if(state.latestCapitalCountry===match.id)state.latestCapitalCountry=null;
        capitalInput.value='';
        showCapitalSuccess(match,total,pair);
        updateCapitalPrompt();
        safelyUpdateAll();
        setTimeout(()=>answerInput.focus(),automatic?180:120);
        return;
      }
      if(match.type==='duplicate'){
        setCapitalFeedback((match.data.name||raw)+' — '+countryName(match.id)+' is already counted.','warn');
        setCapitalCue('Try another capital, or Tab back to countries.','warn');
      }else if(match.type==='ambiguous'){
        setCapitalFeedback('That could match more than one capital. Type the full city name.','warn');
        setCapitalCue('A little more spelling will separate them.','warn');
      }else{
        setCapitalFeedback('Not a recognized capital yet. Keep typing or try another.','bad');
        setCapitalCue('Enter submits; Tab skips back to countries.','warn');
      }
      try{if(typeof shake==='function')shake(capitalShell)}catch(error){}
      capitalInput.select();
    }

    function skipCapital(){
      clearTimeout(window.__atlasCapitalTimer);
      capitalInput.value='';
      setCapitalFeedback('Capital skipped. Keep naming countries.','');
      updateCapitalPrompt();
      answerInput.focus();
    }

    ensureCapitalState();

    const originalStartRound=typeof startRound==='function'?startRound:null;
    if(originalStartRound){
      startRound=function(options){
        state.capitalPairs=new Set();
        state.latestCapitalCountry=null;
        const result=originalStartRound(options);
        ensureCapitalState();
        updateCapitalPrompt();
        syncCapitalAvailability();
        return result;
      };
    }

    const originalRestore=typeof restoreEntryPanel==='function'?restoreEntryPanel:null;
    if(originalRestore){
      restoreEntryPanel=function(){
        const result=originalRestore();
        ensureCapitalState();
        syncCapitalAvailability();
        return result;
      };
    }

    beginCapitalPrompt=function(countryId,fromLadder=false){
      ensureCapitalState();
      state.capitalPending=null;
      if(fromLadder||state.mode==='ladder'||!capitalsEnabled()){
        state.latestCapitalCountry=null;
        syncCapitalAvailability();
        return;
      }
      const pair=state.capitalAnswered.has(countryId)?maybeAwardPair(countryId):0;
      state.latestCapitalCountry=state.capitalAnswered.has(countryId)?null:countryId;
      updateCapitalPrompt();
      syncCapitalAvailability();
      if(pair){
        const name=countryName(countryId);
        const data=CAPITALS[countryId]||{};
        setCapitalFeedback((data.name||'Capital')+' + '+name+' · +50 pair completion.','good');
        setCapitalCue('The capital was entered earlier; the pair is now complete.','ready');
        try{if(typeof showMilestone==='function')showMilestone((name+' PAIR COMPLETE · +50').toUpperCase())}catch(error){}
        setTimeout(safelyUpdateAll,0);
      }
    };

    finishCapitalPrompt=function(){
      ensureCapitalState();
      syncCapitalAvailability();
    };

    const originalUpdateAll=typeof updateAll==='function'?updateAll:null;
    if(originalUpdateAll){
      updateAll=function(){
        const result=originalUpdateAll();
        ensureCapitalState();
        syncCapitalAvailability();
        return result;
      };
    }

    answerInput.addEventListener('keydown',event=>{
      if(event.key==='Tab'&&!event.shiftKey&&!capitalPane.hidden&&!capitalInput.disabled){
        event.preventDefault();
        capitalInput.focus();
        capitalInput.select();
      }
    },true);

    capitalInput.addEventListener('keydown',event=>{
      if(event.key==='Enter'){
        event.preventDefault();
        clearTimeout(window.__atlasCapitalTimer);
        submitAnyCapital(false);
      }else if(event.key==='Tab'||event.key==='Escape'){
        event.preventDefault();
        skipCapital();
      }
    });

    capitalInput.addEventListener('input',()=>{
      clearTimeout(window.__atlasCapitalTimer);
      if(capitalInput.value.trim()&&!state.active){
        const saved=capitalInput.value;
        try{startRound({preserveInput:true})}catch(error){try{startRound()}catch(inner){}}
        capitalInput.value=saved;
        capitalInput.focus();
      }
      const match=classifyCapital(capitalInput.value);
      if(match.type==='empty'){
        updateCapitalPrompt();
      }else if(match.type==='accept'){
        const fuzzy=match.result&&match.result.match==='fuzzy';
        setCapitalCue(fuzzy?'Close match — press Enter to count it.':'Capital recognized — counting it.','ready');
        if(!fuzzy){
          const snapshot=capitalInput.value;
          window.__atlasCapitalTimer=setTimeout(()=>{
            if(capitalInput.value===snapshot&&!state.paused&&!state.ended)submitAnyCapital(true);
          },360);
        }
      }else if(match.type==='duplicate'){
        setCapitalCue('Already counted — try another capital.','warn');
      }else if(match.type==='ambiguous'){
        setCapitalCue('More than one capital fits — type a little more.','warn');
      }else{
        setCapitalCue('Any world capital works here.','');
      }
    });

    capitalSkip.addEventListener('click',skipCapital);
    if(modeSelect)modeSelect.addEventListener('change',()=>setTimeout(()=>{syncCapitalAvailability();updateCapitalPrompt()},0));
    if(capitalModeSelect)capitalModeSelect.addEventListener('change',()=>setTimeout(()=>{syncCapitalAvailability();updateCapitalPrompt()},0));

    if(followBtn&&zoomReset){
      let migrated=false;
      try{migrated=localStorage.getItem('atlasWorldDefaultV1')==='done'}catch(error){}
      if(!migrated){
        if(followBtn.getAttribute('aria-pressed')==='true')followBtn.click();
        try{localStorage.setItem('atlasWorldDefaultV1','done')}catch(error){}
      }
      const refreshFollowCopy=()=>{
        const copy=followBtn.querySelector('.follow-copy');
        if(copy)copy.textContent='Auto zoom';
        const on=followBtn.getAttribute('aria-pressed')==='true';
        followBtn.title=on?'Auto zoom is on — click to keep the whole world visible':'Whole-world view is on — click for optional auto zoom';
        followBtn.setAttribute('aria-label',on?'Turn off automatic map zoom':'Turn on automatic map zoom');
      };
      refreshFollowCopy();
      followBtn.addEventListener('click',()=>setTimeout(refreshFollowCopy,0));
      const keepWorld=()=>{if(!modeSelect||modeSelect.value!=='region')zoomReset.click()};
      keepWorld();
      if(startBtn)startBtn.addEventListener('click',()=>setTimeout(keepWorld,120));
      answerInput.addEventListener('input',()=>{if(!startBtn||startBtn.textContent.trim()!=='Restart')keepWorld()},{capture:true});
    }

    const ruleItems=[...document.querySelectorAll('#rulesDialog li')];
    const capitalRule=ruleItems.find(item=>/capital/i.test(item.textContent));
    if(capitalRule)capitalRule.innerHTML='<strong>Two fields:</strong> keep typing countries in the main field. Tab into the capital field whenever you want; any capital counts for 25 points, and completing its country-capital pair adds 50 more. Enter submits; Tab, Escape, or Skip returns to countries.';
    const followRule=ruleItems.find(item=>item.textContent.trim().startsWith('Follow')||item.textContent.includes('Whole-world view'));
    if(followRule)followRule.innerHTML='<strong>Whole-world view</strong> stays fixed by default so fast answers never leave you looking at the wrong hemisphere. Turn on <strong>Auto zoom</strong> only when you want it.';

    updateCapitalPrompt();
    syncCapitalAvailability();
    window.__atlasTwoFieldReady=true;
  }catch(error){
    window.__atlasTwoFieldError=String(error&&error.stack||error);
    document.body.dataset.twoFieldError=String(error&&error.message||error);
    console.error(error);
  }
}
atlasTwoFieldBoot();
