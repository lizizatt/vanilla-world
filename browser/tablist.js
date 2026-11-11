// Shared WoW-style tab strip: role=tablist, aria-selected, roving tabindex and Left/Right/Home/End navigation.
export function tablist(doc,{label,onSelect}={}){
  const bar=doc.createElement('div');bar.className='wow-tabs';bar.setAttribute('role','tablist');
  if(label)bar.setAttribute('aria-label',label);
  const tabs=[];
  const mark=selected=>{for(const b of tabs){const on=b===selected;b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;b.classList.toggle('on',on);}};
  bar.addEventListener('keydown',e=>{
    const i=tabs.indexOf(doc.activeElement);if(i<0)return;
    const j={ArrowRight:i+1,ArrowLeft:i-1,Home:0,End:tabs.length-1}[e.key];
    if(j===undefined)return;
    e.preventDefault();e.stopPropagation();
    const next=tabs[(j+tabs.length)%tabs.length];next.focus();next.click();
  });
  return {
    bar,tabs,mark,
    add(text,id,onClick){
      const b=doc.createElement('button');b.type='button';b.setAttribute('role','tab');b.textContent=text;b.dataset.tab=id;
      b.addEventListener('click',()=>{onClick?.(id);onSelect?.(id);});
      tabs.push(b);bar.append(b);return b;
    }
  };
}
