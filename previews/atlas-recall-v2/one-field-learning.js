(function atlasOneFieldLearning(){
  if(window.__atlasOneFieldLearningV1)return;

  function boot(){
    const freePanel=document.getElementById('freePanel');
    const answerInput=document.getElementById('answerInput');
    const answerShell=document.getElementById('answerShell');
    const answerLabel=freePanel&&freePanel.querySelector('.answer-label');
    const matchCue=document.getElementById('matchCue');
    const feedback=document.getElementById('feedback');
    const oldCapitalPanel=document.getElementById('capitalPanel');
    if(!freePanel||!answerInput||!answerShell||!answerLabel||!matchCue||!feedback||typeof state!=='object'||typeof CAPITALS!=='object'||typeof resolveAnswer!=='function'||typeof capitalMatch!=='function'){
      setTimeout(boot,60);
      return;
    }

    window.__atlasOneFieldLearningV1=true;
    document.body.dataset.build='one-field-capital-learning-v1';

    const style=document.createElement('style');
    style.id='atlasOneFieldLearningStyles';
    style.textContent=`
      #capitalPanel{display:none!important}
      #freePanel.hidden{display:block!important}
      .learning-context{display:inline-flex;align-items:center;gap:6px;min-width:0;color:var(--warning);font-size:.59rem;font-weight:900;letter-spacing:.025em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .learning-context.generic{color:var(--success)}
      .learning-show-btn{flex:0 0 auto;padding:3px 7px;border:1px solid color-mix(in srgb,var(--warning) 28%,var(--line));border-radius:7px;background:color-mix(in srgb,var(--warning-soft) 58%,var(--panel-2));color:color-mix(in srgb,var(--warning) 84%,var(--ink));font-size:.56rem;font-weight:900;line-height:1.1;cursor:pointer}
      .learning-show-btn:hover{border-color:color-mix(in srgb,var(--warning) 52%,var(--line));background:color-mix(in srgb,var(--warning-soft) 86%,var(--panel-2))}
      .feedback.learning-teach{display:grid;grid-template-columns:auto auto minmax(0,1fr);align-items:center;gap:8px;border-color:color-mix(in srgb,var(--success) 32%,transparent);background:linear-gradient(135deg,color-mix(in srgb,var(--success-soft) 88%,var(--panel-2)),var(--panel-2));color:var(--ink)}
      .learning-teach-kicker{color:var(--success);font-size:.5rem;font-weight:950;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap}
      .learning-teach-answer{font-size:.94rem;line-height:1;font-weight:950;letter-spacing:-.02em;white-space:nowrap}
      .learning-teach-meta{min-width:0;color:var(--muted);font-size:.61rem;font-weight:780;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .learning-stat .stat-value{font-variant-numeric:tabular-nums}
      .learning-stat .stat-sub{display:block!important}
      @media(max-width:980px){.learning-context{font-size:.54rem}.feedback.learning-teach{gap:6px}.learning-teach-meta{display:none}}
      @media(max-width:620px){.learning-show-btn{padding:3px 6px}.learning-context{max-width:58vw}.learning-teach-answer{font-size:.9rem}}
    `;
    document.head.appendChild(style);

    const labelStrong=answerLabel.querySelector('strong');
    if(labelStrong)labelStrong.textContent='Country or capital';
    let context=answerLabel.querySelector('.assist-badge');
    if(!context){
      context=document.createElement('span');
      answerLabel.appendChild(context);
    }
    context.className='learning-context generic';
    context.id='learningContext';
    context.textContent='One field · any order';

    const showButton=document.createElement('button');
    showButton.type='button';
    showButton.className='learning-show-btn';
    showButton.textContent='Show';
    showButton.hidden=true;
    context.appendChild(showButton);


    if(oldCapitalPanel){oldCapitalPanel.hidden=true;oldCapitalPanel.classList.remove('active')}
    freePanel.classList.remove('hidden');
    answerInput.placeholder='Type any country or capital';

    const countryById=new Map((Array.isArray(COUNTRIES)?COUNTRIES:[]).map(country=>[country.id,country]));
    const countryName=id=>countryById.get(id)?.name||(typeof byId!=='undefined'&&byId.get?.(id)?.name)||String(id||'').replace(/-/g,' ').replace(/\b\w/g,char=>char.toUpperCase());
    const normalize=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');

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

    const scoreStat=document.getElementById('scoreStat');
    const scoreSub=document.getElementById('scoreSub');
    const remainingStat=document.getElementById('remainingStat');
    let capitalStat=remainingStat&&remainingStat.closest('.stat');
    let capitalValue=remainingStat;
    let capitalSub=capitalStat&&capitalStat.querySelector('.stat-sub');
    if(capitalStat){
      capitalStat.classList.add('learning-stat');
      const label=capitalStat.querySelector('.stat-label');
      if(label)label.textContent='Capitals';
      if(capitalSub)capitalSub.textContent='0% complete';
    }else{
      const hud=document.querySelector('.hud-stats');
      if(hud){
        capitalStat=document.createElement('div');
        capitalStat.className='stat learning-stat';
        capitalStat.innerHTML='<div class="stat-label">Capitals</div><div class="stat-value" id="learningCapitalStat">0 / 197</div><div class="stat-sub" id="learningCapitalSub">0% complete</div>';
        const countryStat=scoreStat&&scoreStat.closest('.stat');
        countryStat?.after(capitalStat);
        capitalValue=capitalStat.querySelector('.stat-value');
        capitalSub=capitalStat.querySelector('.stat-sub');
      }
    }
    const countryLabel=scoreStat&&scoreStat.closest('.stat')?.querySelector('.stat-label');
    if(countryLabel)countryLabel.textContent='Countries';

    let promptCountryId=null;
    let capitalTimer=null;
    let revealTimer=null;
    let lastEnded=false;

    function ensureCapitalState(){
      if(!(state.capitalAnswered instanceof Set))state.capitalAnswered=new Set(state.capitalAnswered||[]);
      if(!(state.capitalPairs instanceof Set))state.capitalPairs=new Set(state.capitalPairs||[]);
      state.capitalsCorrect=state.capitalAnswered.size;
      state.capitalPending=null;
    }

    function targetIds(){
      if(state.targetIds instanceof Set&&state.targetIds.size)return state.targetIds;
      return new Set(countryById.keys());
    }

    function capitalCount(){
      const targets=targetIds();
      let count=0;
      for(const id of state.capitalAnswered)if(targets.has(id))count++;
      return count;
    }

    function updateProgress(){
      ensureCapitalState();
      const total=targetIds().size||197;
      const countries=state.guessed instanceof Set?[...state.guessed].filter(id=>targetIds().has(id)).length:0;
      const capitals=capitalCount();
      const countryPct=total?Math.round(countries/total*100):0;
      const capitalPct=total?Math.round(capitals/total*100):0;
      if(scoreStat)scoreStat.textContent=countries+' / '+total;
      if(scoreSub)scoreSub.textContent=countryPct+'% complete';
      if(capitalValue)capitalValue.textContent=capitals+' / '+total;
      if(capitalSub)capitalSub.textContent=capitalPct+'% complete';

      if(state.ended&&!lastEnded&&total>=195){
        try{
          const baselineKey='atlasCapitalBaselineV1';
          const bestKey='atlasCapitalBestV1';
          if(localStorage.getItem(baselineKey)==null)localStorage.setItem(baselineKey,String(capitals));
          const best=Math.max(Number(localStorage.getItem(bestKey)||0),capitals);
          localStorage.setItem(bestKey,String(best));
        }catch(error){}
      }
      lastEnded=Boolean(state.ended);
    }

    function hideReveal(){
      clearTimeout(revealTimer);
      revealTimer=null;
      if(feedback.classList.contains('learning-teach')){
        feedback.className='feedback';
        feedback.textContent='Answers remain hidden until you end the round.';
      }
    }

    function showReveal(id,{kind='Capital revealed',typed='',points='',detail=''}={}){
      const data=CAPITALS[id];
      if(!data)return;
      const canonical=data.name||typed||'Capital';
      const corrected=Boolean(typed)&&normalize(typed)!==normalize(canonical);
      const kicker=corrected?'Correct spelling':kind;
      const parts=[countryName(id)];
      if(corrected)parts.push('you typed “'+typed+'”');
      if(points)parts.push(points);
      if(detail)parts.push(detail);
      feedback.className='feedback good learning-teach';
      feedback.innerHTML='<span class="learning-teach-kicker"></span><strong class="learning-teach-answer"></strong><span class="learning-teach-meta"></span>';
      feedback.querySelector('.learning-teach-kicker').textContent=kicker;
      feedback.querySelector('.learning-teach-answer').textContent=canonical;
      feedback.querySelector('.learning-teach-meta').textContent=parts.join(' · ');
      clearTimeout(revealTimer);
      revealTimer=setTimeout(hideReveal,2400);
    }

    function setPrompt(id){
      promptCountryId=id&&CAPITALS[id]&&!state.capitalAnswered.has(id)?id:null;
      if(promptCountryId){
        context.className='learning-context';
        context.firstChild.textContent='Capital of '+countryName(promptCountryId)+'? ';
        showButton.hidden=false;
        answerInput.placeholder='Capital of '+countryName(promptCountryId)+' — or next country';
        setCue(matchCue,'Type the capital, any other capital, or your next country.','');
      }else{
        context.className='learning-context generic';
        context.firstChild.textContent='One field · any order ';
        showButton.hidden=true;
        answerInput.placeholder='Type any country or capital';
        setCue(matchCue,'Countries and capitals both count.','');
      }
    }

    function classifyCapital(raw){
      const value=String(raw||'').trim();
      if(!value||!capitalsEnabled())return{type:'empty'};
      const hits=[];
      const targets=targetIds();
      for(const [id,data] of Object.entries(CAPITALS||{})){
        if(targets.size&&!targets.has(id))continue;
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

    function countryDecision(raw){
      try{return resolveAnswer(raw,{ladder:false})}catch(error){return{type:'none'}}
    }

    function expectedCapitalDecision(raw){
      if(!promptCountryId||state.capitalAnswered.has(promptCountryId))return null;
      const data=CAPITALS[promptCountryId];
      if(!data)return null;
      try{
        const result=capitalMatch(raw,data);
        return result&&result.ok?{type:'accept',id:promptCountryId,data,result,expected:true}:null;
      }catch(error){return null}
    }

    function decide(raw){
      const expected=expectedCapitalDecision(raw);
      if(expected)return{kind:'capital',match:expected};
      const country=countryDecision(raw);
      if(country?.type==='accept')return{kind:'country',country};
      const capital=classifyCapital(raw);
      if(capital.type==='accept')return{kind:'capital',match:capital};
      return{kind:'none',country,capital};
    }

    function pairIsComplete(id){
      return state.guessed instanceof Set&&state.guessed.has(id)&&state.capitalAnswered.has(id);
    }

    function awardPair(id){
      ensureCapitalState();
      if(pairIsComplete(id)&&!state.capitalPairs.has(id)){
        state.capitalPairs.add(id);
        state.score+=50;
        return 50;
      }
      return 0;
    }

    function reconcilePairs(){
      ensureCapitalState();
      for(const id of [...state.capitalPairs]){
        if(!pairIsComplete(id)){
          state.capitalPairs.delete(id);
          state.score=Math.max(0,state.score-50);
        }
      }
    }

    function safeUpdateAll(){
      try{updateAll()}catch(error){}
      reconcilePairs();
      updateProgress();
      freePanel.classList.remove('hidden');
      if(oldCapitalPanel){oldCapitalPanel.hidden=true;oldCapitalPanel.classList.remove('active')}
    }

    function submitCapital(match,typed,automatic=false){
      ensureCapitalState();
      if(!match||match.type!=='accept'||state.paused||state.ended)return;
      if(!state.active){
        const saved=answerInput.value;
        try{startRound({preserveInput:true})}catch(error){try{startRound()}catch(inner){}}
        answerInput.value=saved;
      }
      if(state.capitalAnswered.has(match.id))return;
      state.capitalAnswered.add(match.id);
      state.capitalsCorrect=state.capitalAnswered.size;
      state.score+=25;
      const pair=awardPair(match.id);
      const total=25+pair;
      answerInput.value='';
      clearTimeout(capitalTimer);
      if(promptCountryId===match.id)promptCountryId=null;
      const corrected=match.result&&match.result.match==='fuzzy';
      showReveal(match.id,{kind:corrected?'Correct spelling':'Spelling confirmed',typed,points:'+'+total+(pair?' pair':' capital')});
      setPrompt(promptCountryId);
      safeUpdateAll();
      try{if(typeof playSfx==='function')playSfx('success',pair?1:.8)}catch(error){}
      try{if(typeof showMilestone==='function')showMilestone(((match.data.name||typed)+' · +'+total+(pair?' PAIR':' CAPITAL')).toUpperCase())}catch(error){}
      setTimeout(()=>answerInput.focus(),automatic?80:40);
    }

    function revealPrompt({manual=false}={}){
      if(!promptCountryId)return;
      const id=promptCountryId;
      showReveal(id,{kind:manual?'Capital shown':'Capital to learn',detail:'not counted yet'});
      promptCountryId=null;
      setPrompt(null);
      answerInput.value='';
      answerInput.focus();
    }

    const originalBeginCapitalPrompt=typeof beginCapitalPrompt==='function'?beginCapitalPrompt:null;
    beginCapitalPrompt=function(countryId,fromLadder=false){
      ensureCapitalState();
      state.capitalPending=null;
      freePanel.classList.remove('hidden');
      if(oldCapitalPanel){oldCapitalPanel.hidden=true;oldCapitalPanel.classList.remove('active')}
      if(fromLadder||state.mode==='ladder'||!capitalsEnabled()){
        setPrompt(null);
        return;
      }

      if(promptCountryId&&promptCountryId!==countryId&&!state.capitalAnswered.has(promptCountryId)){
        showReveal(promptCountryId,{kind:'Capital to learn',detail:'shown · not counted'});
      }

      if(state.capitalAnswered.has(countryId)){
        const pair=awardPair(countryId);
        if(pair){
          showReveal(countryId,{kind:'Pair complete',points:'+50 pair'});
        }
        setPrompt(null);
      }else{
        const sameName=normalize(CAPITALS[countryId]?.name)===normalize(countryName(countryId));
        if(sameName){
          const match={type:'accept',id:countryId,data:CAPITALS[countryId],result:{match:'exact'}};
          submitCapital(match,countryName(countryId),true);
        }else{
          setPrompt(countryId);
        }
      }
      safeUpdateAll();
      setTimeout(()=>answerInput.focus(),20);
    };

    finishCapitalPrompt=function(){
      ensureCapitalState();
      state.capitalPending=null;
      freePanel.classList.remove('hidden');
      if(oldCapitalPanel){oldCapitalPanel.hidden=true;oldCapitalPanel.classList.remove('active')}
      setTimeout(()=>answerInput.focus(),0);
    };

    if(typeof restoreEntryPanel==='function'){
      restoreEntryPanel=function(){
        state.capitalPending=null;
        freePanel.classList.remove('hidden');
        if(oldCapitalPanel){oldCapitalPanel.hidden=true;oldCapitalPanel.classList.remove('active')}
        return freePanel;
      };
    }

    const originalStartRound=typeof startRound==='function'?startRound:null;
    if(originalStartRound){
      startRound=function(options){
        promptCountryId=null;
        hideReveal();
        const result=originalStartRound(options);
        state.capitalAnswered=new Set();
        state.capitalPairs=new Set();
        state.capitalsCorrect=0;
        state.capitalPending=null;
        setPrompt(null);
        safeUpdateAll();
        return result;
      };
    }

    const originalUpdateAll=typeof updateAll==='function'?updateAll:null;
    if(originalUpdateAll){
      updateAll=function(){
        const result=originalUpdateAll();
        ensureCapitalState();
        reconcilePairs();
        updateProgress();
        freePanel.classList.remove('hidden');
        if(oldCapitalPanel){oldCapitalPanel.hidden=true;oldCapitalPanel.classList.remove('active')}
        return result;
      };
    }

    function inspectInput(){
      clearTimeout(capitalTimer);
      const raw=answerInput.value.trim();
      if(!raw){
        if(promptCountryId)setCue(matchCue,'Capital of '+countryName(promptCountryId)+', any other capital, or your next country.','');
        return;
      }
      const decision=decide(raw);
      if(decision.kind==='capital'){
        try{clearTimeout(autoSubmitTimer)}catch(error){}
        const fuzzy=decision.match.result&&decision.match.result.match==='fuzzy';
        if(fuzzy){
          setCue(matchCue,'Close spelling — press Enter to accept it and see the standard spelling.','close');
        }else{
          setCue(matchCue,(decision.match.expected?'Capital recognized':'Capital recognized out of order')+' — counting it.','ready');
          const snapshot=raw;
          capitalTimer=setTimeout(()=>{
            if(answerInput.value===snapshot&&!state.paused&&!state.ended){
              const fresh=decide(snapshot);
              if(fresh.kind==='capital')submitCapital(fresh.match,snapshot,true);
            }
          },420);
        }
      }else if(decision.kind==='country'&&promptCountryId){
        setCue(matchCue,'Next country recognized — '+countryName(promptCountryId)+'’s capital will be shown briefly.','ready');
      }
    }

    answerInput.addEventListener('input',()=>{
      setTimeout(inspectInput,0);
    },true);

    answerInput.addEventListener('keydown',event=>{
      if(promptCountryId&&((event.key==='Enter'&&!answerInput.value.trim())||(event.key==='Tab'&&!event.shiftKey))){
        event.preventDefault();
        event.stopImmediatePropagation();
        clearTimeout(capitalTimer);
        try{clearTimeout(autoSubmitTimer)}catch(error){}
        revealPrompt({manual:true});
        return;
      }
      if(event.key==='Enter'){
        const raw=answerInput.value.trim();
        if(!raw)return;
        const decision=decide(raw);
        if(decision.kind==='capital'){
          event.preventDefault();
          event.stopImmediatePropagation();
          clearTimeout(capitalTimer);
          try{clearTimeout(autoSubmitTimer)}catch(error){}
          submitCapital(decision.match,raw,false);
        }
      }else if(event.key==='Escape'&&promptCountryId){
        event.preventDefault();
        revealPrompt({manual:true});
      }
    },true);

    showButton.addEventListener('click',event=>{
      event.preventDefault();
      revealPrompt({manual:true});
    });

    if(capitalModeSelect)capitalModeSelect.addEventListener('change',()=>setTimeout(()=>{
      if(!capitalsEnabled())setPrompt(null);
      updateProgress();
    },0));

    const followBtn=document.getElementById('followBtn');
    const zoomReset=document.getElementById('zoomReset');
    const modeSelect=document.getElementById('modeSelect');
    const startBtn=document.getElementById('startBtn');
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
    if(capitalRule)capitalRule.innerHTML='<strong>One field:</strong> after each country, the field softly asks for that capital. Answer it, enter any other capital, or simply type the next country. Moving on, blank Enter, Tab, or Show briefly reveals the skipped capital without counting it. Exact spellings count automatically; a close spelling requires Enter and then shows the standard spelling.';
    const followRule=ruleItems.find(item=>item.textContent.trim().startsWith('Follow')||item.textContent.includes('Whole-world view'));
    if(followRule)followRule.innerHTML='<strong>Whole-world view</strong> stays fixed by default so fast answers never leave you looking at the wrong hemisphere. Turn on <strong>Auto zoom</strong> only when you want it.';

    ensureCapitalState();
    setPrompt(null);
    updateProgress();
    freePanel.classList.remove('hidden');
    if(oldCapitalPanel){oldCapitalPanel.hidden=true;oldCapitalPanel.classList.remove('active')}
    window.__atlasOneFieldLearningReady=true;
  }

  boot();
})();
