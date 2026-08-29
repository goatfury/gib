(function atlasEndAnswerKey(){
  if(window.__atlasEndAnswerKeyV1)return;

  function boot(){
    const reviewDialog=document.getElementById('reviewDialog');
    const reviewTitle=document.getElementById('reviewTitle');
    const reviewSubtitle=document.getElementById('reviewSubtitle');
    const reviewBody=document.getElementById('reviewBody');
    const checklistTotal=document.getElementById('checklistTotal');
    if(!window.__atlasOneFieldLearningReady||!reviewDialog||!reviewTitle||!reviewSubtitle||!reviewBody||typeof state!=='object'||typeof CAPITALS!=='object'||typeof updateReview!=='function'||typeof updateChecklist!=='function'||typeof updateAll!=='function'){
      setTimeout(boot,60);
      return;
    }

    window.__atlasEndAnswerKeyV1=true;
    document.body.dataset.endAnswerKey='all-misses-v1';

    const style=document.createElement('style');
    style.id='atlasEndAnswerKeyStyles';
    style.textContent=`
      .answer-key-summary{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px}
      .answer-key-chip{padding:6px 9px;border:1px solid var(--line);border-radius:999px;background:var(--panel-2);color:var(--muted);font-size:.67rem;font-weight:850;font-variant-numeric:tabular-nums}
      .answer-key-section+.answer-key-section{margin-top:16px;padding-top:15px;border-top:1px solid var(--line)}
      .answer-key-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:8px}
      .answer-key-section-head h3{margin:0;font-size:.86rem}
      .answer-key-section-head span{color:var(--muted);font-size:.64rem;font-weight:800}
      .answer-key-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:7px}
      .answer-key-card{min-width:0;padding:9px 10px;border:1px solid var(--line);border-radius:11px;background:var(--panel-2)}
      .answer-key-card h4{margin:0;font-size:.76rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .answer-key-capital{margin:3px 0 0!important;color:var(--ink)!important;font-size:.76rem!important;font-weight:880}
      .answer-key-status{display:block;margin-top:4px;color:var(--muted);font-size:.58rem;font-weight:780}
      .country-slot.answer-key-pair{min-height:42px}
      .country-slot.answer-key-pair .slot-name{white-space:normal;line-height:1.18;font-size:.62rem}
      .country-slot.answer-key-pair.answer-key-incomplete .slot-name{font-weight:860}
      @media(max-width:620px){.answer-key-grid{grid-template-columns:1fr}.country-slot.answer-key-pair .slot-name{font-size:.64rem}}
    `;
    document.head.appendChild(style);

    const countryById=new Map((Array.isArray(COUNTRIES)?COUNTRIES:[]).map(country=>[country.id,country]));
    const countryName=id=>countryById.get(id)?.name||(typeof byId!=='undefined'&&byId.get?.(id)?.name)||String(id||'').replace(/-/g,' ').replace(/\b\w/g,char=>char.toUpperCase());
    const capitalName=id=>CAPITALS[id]?.name||'Capital not configured';
    const escapeHtml=value=>String(value??'').replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));
    const targetIds=()=>state.targetIds instanceof Set&&state.targetIds.size?[...state.targetIds]:[...countryById.keys()];
    const countryKnown=id=>state.guessed instanceof Set&&state.guessed.has(id);
    const capitalKnown=id=>state.capitalAnswered instanceof Set&&state.capitalAnswered.has(id);

    function totals(){
      const ids=targetIds();
      return{
        ids,
        total:ids.length,
        countries:ids.filter(countryKnown).length,
        capitals:ids.filter(capitalKnown).length
      };
    }

    function card(id){
      const country=countryName(id);
      const capital=capitalName(id);
      const hasCountry=countryKnown(id);
      const hasCapital=capitalKnown(id);
      let status='';
      if(!hasCountry&&!hasCapital)status='Country and capital revealed';
      else if(!hasCountry)status='Country revealed · capital was recalled';
      else status='Capital revealed · country was recalled';
      return `<article class="answer-key-card"><h4 title="${escapeHtml(country)}">${escapeHtml(country)}</h4><p class="answer-key-capital">${escapeHtml(capital)}</p><span class="answer-key-status">${escapeHtml(status)}</span></article>`;
    }

    function section(title,ids,description){
      if(!ids.length)return'';
      return `<section class="answer-key-section"><div class="answer-key-section-head"><h3>${escapeHtml(title)}</h3><span>${ids.length} ${escapeHtml(description)}</span></div><div class="answer-key-grid">${ids.map(card).join('')}</div></section>`;
    }

    function renderEndReview(){
      if(!state.ended)return;
      const summary=totals();
      const sorted=[...summary.ids].sort((a,b)=>countryName(a).localeCompare(countryName(b)));
      const missedCountries=sorted.filter(id=>!countryKnown(id));
      const missedCapitals=sorted.filter(id=>countryKnown(id)&&!capitalKnown(id));
      const incomplete=missedCountries.length+missedCapitals.length;

      reviewTitle.textContent=incomplete?'Complete answer key':'Perfect country–capital round';
      reviewSubtitle.textContent=incomplete
        ?'Every unanswered country and capital is now revealed. Reveals do not increase your score.'
        :'Every target country and capital was recalled without a reveal.';

      const summaryHtml=`<div class="answer-key-summary"><span class="answer-key-chip">Countries ${summary.countries} / ${summary.total}</span><span class="answer-key-chip">Capitals ${summary.capitals} / ${summary.total}</span><span class="answer-key-chip">${incomplete} incomplete pairs</span></div>`;
      if(!incomplete){
        reviewBody.innerHTML=summaryHtml+'<div class="learning-card"><h4>Clean sweep</h4><p>You supplied every country and every capital.</p></div>';
        return;
      }
      reviewBody.innerHTML=summaryHtml
        +section('Countries you missed',missedCountries,'country answers')
        +section('Capitals you missed',missedCapitals,'capital answers');
    }

    function revealChecklistPairs(){
      if(!state.ended)return;
      const summary=totals();
      for(const id of summary.ids){
        const slot=document.querySelector(`.country-slot[data-id="${CSS.escape(id)}"]`);
        if(!slot)continue;
        const name=slot.querySelector('.slot-name');
        if(!name)continue;
        const pair=countryName(id)+' — '+capitalName(id);
        name.textContent=pair;
        name.title=pair;
        slot.classList.add('answer-key-pair');
        slot.classList.toggle('answer-key-incomplete',!countryKnown(id)||!capitalKnown(id));
      }
      if(checklistTotal)checklistTotal.textContent=`${summary.countries} / ${summary.total} countries · ${summary.capitals} / ${summary.total} capitals · full answer key`;
    }

    let wasEnded=Boolean(state.ended);
    let openTimer=null;

    function openAnswerKey(attempt=0){
      if(!state.ended||reviewDialog.open)return;
      const other=[...document.querySelectorAll('dialog[open]')].find(dialog=>dialog!==reviewDialog);
      if(other&&attempt<15){
        openTimer=setTimeout(()=>openAnswerKey(attempt+1),100);
        return;
      }
      try{reviewDialog.showModal()}catch(error){try{reviewDialog.setAttribute('open','')}catch(inner){}}
    }

    const originalUpdateReview=updateReview;
    updateReview=function(){
      const result=originalUpdateReview();
      if(state.ended)renderEndReview();
      return result;
    };

    const originalUpdateChecklist=updateChecklist;
    updateChecklist=function(){
      const result=originalUpdateChecklist();
      if(state.ended)revealChecklistPairs();
      return result;
    };

    const originalUpdateAll=updateAll;
    updateAll=function(){
      const result=originalUpdateAll();
      if(state.ended){
        renderEndReview();
        revealChecklistPairs();
      }
      if(state.ended&&!wasEnded){
        clearTimeout(openTimer);
        openTimer=setTimeout(()=>openAnswerKey(),220);
      }
      wasEnded=Boolean(state.ended);
      return result;
    };

    if(typeof startRound==='function'){
      const originalStartRound=startRound;
      startRound=function(options){
        clearTimeout(openTimer);
        wasEnded=false;
        if(reviewDialog.open){try{reviewDialog.close()}catch(error){reviewDialog.removeAttribute('open')}}
        const result=originalStartRound(options);
        return result;
      };
    }

    const ruleItems=[...document.querySelectorAll('#rulesDialog li')];
    const revealRule=ruleItems.find(item=>/missing names stay hidden|round ends|reveal/i.test(item.textContent));
    if(revealRule)revealRule.innerHTML='<strong>End-of-round answer key:</strong> when the round ends, every country or capital you missed is revealed automatically. The full country–capital key also appears in the A–Z list below. Revealed answers teach you, but never inflate your score.';

    if(state.ended){
      renderEndReview();
      revealChecklistPairs();
    }
    window.__atlasEndAnswerKeyReady=true;
  }

  boot();
})();
