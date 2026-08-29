(function atlasCapitalSpellingFeedback(){
  if(window.__atlasCapitalSpellingFeedbackV1)return;

  function boot(){
    const capitalInput=document.getElementById('anyCapitalInput');
    const capitalShell=document.getElementById('anyCapitalShell');
    const capitalCue=document.getElementById('capitalAnyCue');
    const capitalFeedback=document.getElementById('capitalAnyFeedback');
    const capitalSkip=document.getElementById('anyCapitalSkip');
    const capitalPane=document.getElementById('alwaysCapitalPane');
    if(!capitalInput||!capitalShell||!capitalCue||!capitalFeedback||!capitalPane){
      setTimeout(boot,60);
      return;
    }

    window.__atlasCapitalSpellingFeedbackV1=true;
    document.body.dataset.spellingFeedback='canonical-in-field-v1';

    const style=document.createElement('style');
    style.id='atlasCapitalSpellingFeedbackStyles';
    style.textContent=`
      #anyCapitalShell{overflow:hidden}
      #anyCapitalShell.spelling-show::after{opacity:0}
      .capital-spelling-reveal{position:absolute;inset:0;z-index:5;display:grid;grid-template-columns:auto auto minmax(0,1fr);align-items:center;gap:8px;padding:6px 12px;border:1px solid color-mix(in srgb,var(--success) 42%,var(--line));border-radius:14px;background:linear-gradient(135deg,color-mix(in srgb,var(--panel-solid) 97%,transparent),color-mix(in srgb,var(--success-soft) 90%,var(--panel-solid)));box-shadow:0 10px 28px rgba(0,0,0,.28),0 0 20px color-mix(in srgb,var(--success) 12%,transparent);opacity:0;visibility:hidden;transform:translateY(5px) scale(.985);pointer-events:none;transition:opacity .16s ease,transform .16s ease,visibility .16s}
      .capital-spelling-reveal.show{opacity:1;visibility:visible;transform:translateY(0) scale(1)}
      .capital-spelling-kicker{color:var(--success);font-size:.5rem;font-weight:950;letter-spacing:.09em;text-transform:uppercase;white-space:nowrap}
      .capital-spelling-answer{font-size:1.05rem;line-height:1;font-weight:950;letter-spacing:-.025em;white-space:nowrap}
      .capital-spelling-meta{min-width:0;color:var(--muted);font-size:.58rem;font-weight:760;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      @media(max-width:980px){.capital-spelling-reveal{gap:6px;padding-inline:9px}.capital-spelling-meta{display:none}}
    `;
    document.head.appendChild(style);

    const reveal=document.createElement('div');
    reveal.className='capital-spelling-reveal';
    reveal.id='capitalSpellingReveal';
    reveal.setAttribute('role','status');
    reveal.setAttribute('aria-live','polite');
    reveal.setAttribute('aria-atomic','true');
    reveal.innerHTML='<span class="capital-spelling-kicker" id="capitalSpellingKicker">Spelling confirmed</span><strong class="capital-spelling-answer" id="capitalSpellingAnswer"></strong><span class="capital-spelling-meta" id="capitalSpellingMeta"></span>';
    capitalShell.appendChild(reveal);

    const kicker=reveal.querySelector('#capitalSpellingKicker');
    const answer=reveal.querySelector('#capitalSpellingAnswer');
    const meta=reveal.querySelector('#capitalSpellingMeta');
    let lastTyped='';
    let lastSignature='';
    let revealTimer=null;
    let inspectTimer=null;

    const normalize=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');

    function hideReveal(){
      clearTimeout(revealTimer);
      revealTimer=null;
      capitalShell.classList.remove('spelling-show');
      reveal.classList.remove('show');
    }

    function showFromFeedback(){
      if(!capitalFeedback.classList.contains('good'))return;
      const text=capitalFeedback.textContent.trim();
      const divider=' — ';
      const split=text.indexOf(divider);
      if(split<1)return;
      const canonical=text.slice(0,split).trim();
      const details=text.slice(split+divider.length).trim();
      if(!canonical)return;
      const signature=canonical+'|'+details+'|'+lastTyped;
      if(signature===lastSignature&&reveal.classList.contains('show'))return;
      lastSignature=signature;
      const corrected=Boolean(lastTyped)&&normalize(lastTyped)!==normalize(canonical);
      kicker.textContent=corrected?'Correct spelling':'Spelling confirmed';
      answer.textContent=canonical;
      meta.textContent=(corrected?'You typed “'+lastTyped+'” · ':'')+details;
      capitalShell.classList.add('spelling-show');
      reveal.classList.add('show');
      clearTimeout(revealTimer);
      revealTimer=setTimeout(hideReveal,1900);
    }

    function inspectSoon(){
      clearTimeout(inspectTimer);
      inspectTimer=setTimeout(showFromFeedback,0);
    }

    capitalInput.addEventListener('input',()=>{
      hideReveal();
      lastTyped=capitalInput.value.trim();
      setTimeout(()=>{
        if(/close match/i.test(capitalCue.textContent)){
          capitalCue.textContent='Close spelling — press Enter to accept it and see the standard spelling.';
        }
      },0);
    },true);

    capitalInput.addEventListener('keydown',event=>{
      if(event.key==='Enter')lastTyped=capitalInput.value.trim();
      if(event.key==='Tab'||event.key==='Escape')hideReveal();
    },true);
    capitalInput.addEventListener('focus',hideReveal);
    if(capitalSkip)capitalSkip.addEventListener('click',hideReveal,true);

    const observer=new MutationObserver(inspectSoon);
    observer.observe(capitalFeedback,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['class']});

    const ruleItems=[...document.querySelectorAll('#rulesDialog li')];
    const capitalRule=ruleItems.find(item=>/capital/i.test(item.textContent));
    if(capitalRule)capitalRule.innerHTML='<strong>Two fields:</strong> keep typing countries in the main field. Tab into the capital field whenever you want; any capital counts for 25 points, and completing its country-capital pair adds 50 more. Exact spellings count automatically. A close spelling requires Enter; after either one, the standard spelling appears in the field briefly. Tab, Escape, or Skip returns to countries.';

    window.__atlasCapitalSpellingFeedbackReady=true;
  }

  boot();
})();
