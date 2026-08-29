(function atlasLetterHints(){
  if(window.__atlasLetterHintsV1)return;

  function boot(){
    const hintButton=document.getElementById('oddHintBtn');
    const answerInput=document.getElementById('answerInput');
    const matchCue=document.getElementById('matchCue');
    const context=document.getElementById('learningContext');
    const oddHintCard=document.getElementById('oddHintCard');
    if(!hintButton||!answerInput||!matchCue||!context||typeof state!=='object'||typeof CAPITALS!=='object'||!Array.isArray(COUNTRIES)){
      setTimeout(boot,60);
      return;
    }

    window.__atlasLetterHintsV1=true;
    document.body.dataset.letterHints='first-then-second-v1';

    const style=document.createElement('style');
    style.id='atlasLetterHintStyles';
    style.textContent=`
      .letter-hint-badge{display:inline-flex;align-items:center;max-width:190px;padding:3px 7px;border:1px solid color-mix(in srgb,var(--warning) 38%,var(--line));border-radius:999px;background:color-mix(in srgb,var(--warning-soft) 72%,var(--panel-2));color:color-mix(in srgb,var(--warning) 88%,var(--ink));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.58rem;font-weight:950;letter-spacing:.045em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .country-shape.letter-hint-target:not(.guessed):not(.missed){fill:var(--warning)!important;filter:drop-shadow(0 0 7px color-mix(in srgb,var(--warning) 72%,transparent))!important;opacity:1!important}
      .country-marker.letter-hint-target:not(.guessed):not(.missed) .marker-core{fill:var(--warning)!important;filter:drop-shadow(0 0 6px color-mix(in srgb,var(--warning) 72%,transparent))!important}
      #oddHintBtn.letter-hint-live{border-color:color-mix(in srgb,var(--warning) 52%,var(--line));background:color-mix(in srgb,var(--warning-soft) 70%,var(--panel-2));color:color-mix(in srgb,var(--warning) 90%,var(--ink))}
      @media(max-width:620px){.letter-hint-badge{max-width:130px;padding:3px 6px;font-size:.54rem}}
    `;
    document.head.appendChild(style);

    const badge=document.createElement('span');
    badge.id='letterHintBadge';
    badge.className='letter-hint-badge';
    badge.hidden=true;
    context.appendChild(badge);

    const countryById=new Map(COUNTRIES.map(country=>[country.id,country]));
    const countryIdByName=new Map(COUNTRIES.map(country=>[country.name,country.id]));
    const hintState={kind:null,id:null,stage:0,countryCountAtStart:0};
    window.__atlasLetterHintState=hintState;

    const guessedCount=()=>state.guessed instanceof Set?state.guessed.size:0;
    const targetIds=()=>state.targetIds instanceof Set&&state.targetIds.size?state.targetIds:new Set(countryById.keys());
    const countryName=id=>countryById.get(id)?.name||String(id||'').replace(/-/g,' ').replace(/\b\w/g,char=>char.toUpperCase());

    function currentCapitalPromptId(){
      const raw=String(context.firstChild&&context.firstChild.nodeValue||'').trim();
      const match=raw.match(/^Capital of (.+?)\?$/);
      return match?countryIdByName.get(match[1].trim())||null:null;
    }

    function isLetter(char){
      try{return /[\p{L}\p{N}]/u.test(char)}catch(error){return /[A-Za-z0-9]/.test(char)}
    }

    function maskedAnswer(value,count){
      let shown=0;
      return Array.from(String(value||'')).map(char=>{
        if(!isLetter(char))return char;
        shown+=1;
        return shown<=count?char:'•';
      }).join('');
    }

    function clearHighlights(){
      document.querySelectorAll('.letter-hint-target').forEach(node=>node.classList.remove('letter-hint-target'));
    }

    function highlightCountry(id){
      clearHighlights();
      document.querySelectorAll(`[data-id="${id}"]`).forEach(node=>{
        if(node.classList.contains('country-shape')||node.classList.contains('country-marker'))node.classList.add('letter-hint-target');
      });
    }

    function clearHint(){
      hintState.kind=null;
      hintState.id=null;
      hintState.stage=0;
      hintState.countryCountAtStart=guessedCount();
      badge.hidden=true;
      badge.textContent='';
      hintButton.classList.remove('letter-hint-live');
      clearHighlights();
      refreshButton();
    }

    function chooseCountry(){
      const targets=targetIds();
      const choices=COUNTRIES.filter(country=>targets.has(country.id)&&!(state.guessed instanceof Set&&state.guessed.has(country.id)));
      if(!choices.length)return null;
      return choices[Math.floor(Math.random()*choices.length)].id;
    }

    function targetCanonical(){
      if(hintState.kind==='capital')return CAPITALS[hintState.id]?.name||'';
      if(hintState.kind==='country')return countryName(hintState.id);
      return '';
    }

    function renderHint(){
      const canonical=targetCanonical();
      if(!canonical||!hintState.stage){clearHint();return}
      const masked=maskedAnswer(canonical,hintState.stage);
      const label=hintState.kind==='capital'?'Capital':'Country';
      badge.textContent=label+': '+masked;
      badge.hidden=false;
      hintButton.classList.add('letter-hint-live');
      if(hintState.kind==='country')highlightCountry(hintState.id);
      else clearHighlights();
      if(typeof setCue==='function')setCue(matchCue,label+' hint · '+masked+(hintState.kind==='country'?' · highlighted on the map.':''),'ready');
      else matchCue.textContent=label+' hint · '+masked;
      refreshButton();
    }

    function refreshButton(){
      hintButton.title='Show the first letter, then the second letter';
      hintButton.setAttribute('aria-label','Letter hint');
      if(!state.active||state.paused||state.ended){
        hintButton.disabled=true;
        hintButton.textContent='Hint';
        return;
      }
      const promptId=currentCapitalPromptId();
      const hasCountry=[...targetIds()].some(id=>!(state.guessed instanceof Set&&state.guessed.has(id)));
      if(!promptId&&!hasCountry){
        hintButton.disabled=true;
        hintButton.textContent='Hint';
        return;
      }
      if(hintState.stage===1){
        hintButton.disabled=false;
        hintButton.textContent='2nd letter';
      }else if(hintState.stage>=2){
        hintButton.disabled=true;
        hintButton.textContent='2 letters shown';
      }else{
        hintButton.disabled=false;
        hintButton.textContent='Hint';
      }
    }

    function ensureTarget(){
      const promptId=currentCapitalPromptId();
      if(promptId){
        if(hintState.kind!=='capital'||hintState.id!==promptId){
          clearHint();
          hintState.kind='capital';
          hintState.id=promptId;
          hintState.countryCountAtStart=guessedCount();
        }
        return true;
      }
      if(hintState.kind==='capital')clearHint();
      if(!hintState.id){
        const id=chooseCountry();
        if(!id)return false;
        hintState.kind='country';
        hintState.id=id;
        hintState.countryCountAtStart=guessedCount();
      }
      return true;
    }

    function useHint(event){
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if(hintButton.disabled||!state.active||state.paused||state.ended)return;
      if(oddHintCard)oddHintCard.classList.remove('show');
      if(!ensureTarget())return;
      if(hintState.stage<2)hintState.stage+=1;
      renderHint();
      answerInput.focus();
    }

    function reconcileHint(){
      const promptId=currentCapitalPromptId();
      if(!state.active||state.ended){clearHint();return}
      if(hintState.kind==='capital'){
        const answered=state.capitalAnswered instanceof Set&&state.capitalAnswered.has(hintState.id);
        if(answered||promptId!==hintState.id)clearHint();
      }else if(hintState.kind==='country'){
        const answered=state.guessed instanceof Set&&state.guessed.has(hintState.id);
        const movedOn=guessedCount()>hintState.countryCountAtStart&&!answered;
        if(answered||movedOn)clearHint();
      }
      refreshButton();
    }

    hintButton.addEventListener('click',useHint,true);
    answerInput.addEventListener('input',()=>setTimeout(reconcileHint,520),true);

    const originalUpdateAll=typeof updateAll==='function'?updateAll:null;
    if(originalUpdateAll){
      updateAll=function(){
        const result=originalUpdateAll();
        reconcileHint();
        return result;
      };
    }

    const ruleItems=[...document.querySelectorAll('#rulesDialog li')];
    const oldHintRule=ruleItems.find(item=>/Odd hint|hint/i.test(item.textContent)&&!/capital/i.test(item.textContent));
    if(oldHintRule)oldHintRule.innerHTML='<strong>Hint</strong> reveals only the first letter. Click again for the second. While a capital is pending, it hints that capital; otherwise it selects and highlights one unrecalled country.';

    if(oddHintCard)oddHintCard.classList.remove('show');
    clearHint();
    window.__atlasLetterHintsReady=true;
  }

  boot();
})();
