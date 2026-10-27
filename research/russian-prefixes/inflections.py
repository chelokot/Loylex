#!/usr/bin/env python3
"""Known-dictionary inflection control. Run with pinned pymorphy3 environment."""
import collections,csv,gzip,json,statistics
from pathlib import Path
import pymorphy3
from analyze import HERE,CYR,norm,load,compute,quantile,sorted_prefixes

def main():
    out=HERE/'results';data=HERE.parents[1]/'data/russian-prefix-research'
    morphs,core,surface,head,mapped,broad,audit=load(data)
    original=collections.defaultdict(set)
    for word,f in mapped:original[word].add(f)
    morph=pymorphy3.MorphAnalyzer()
    normalised=set();changed=0;unknown=0
    normal_forms={}
    for word in sorted(original):
        nfs={norm(p.normal_form) for p in morph.parse(word) if p.is_known and norm(p.normal_form) in original}
        normal_forms[word]=nfs
        families=set().union(*(original[nf] for nf in nfs)) if nfs else original[word]
        changed+=families!=original[word];unknown+=not bool(nfs)
        normalised.update((word,f) for f in families)
    rows,s=compute('lemma_families',normalised,morphs,out)
    # Serialize the normalized lemma assignments, then release row objects before expansion.
    s.update(inflection_assignments_changed=changed,no_known_normal_form_in_seed=unknown)
    del rows
    normalized=collections.defaultdict(set)
    for word,f in normalised:normalized[word].add(f)
    pairs=set(normalised);matched=0
    for i,word in enumerate(sorted(normalized)):
        parses=[p for p in morph.parse(word) if p.is_known and norm(p.normal_form)==word]
        if not parses:continue
        matched+=1
        forms={norm(form.word) for p in parses for form in p.lexeme}
        for form in forms:
            if CYR.fullmatch(form):pairs.update((form,f) for f in normalized[word])
        if i%10000==0:print('expanded',i,'pairs',len(pairs),flush=True)
    # Sorting instead of a Python-object trie bounds memory for the much larger form lexicon.
    ordered=sorted(pairs);del pairs
    counts=collections.Counter();family=collections.Counter();n=0;eof=0;ambiguous=0;total_letters=0;sum_saved=0
    examples=collections.defaultdict(list)
    with gzip.open(out/'inflected_forms.csv.gz','wt',encoding='utf-8-sig',newline='') as h:
        writer=csv.writer(h);writer.writerow(['form','family','word_letters','prefix','prefix_letters','needs_end_marker','competitor'])
        for word,f,k,other,end_marker in sorted_prefixes(ordered):
            letters=sum(c.isalpha() for c in word); kl=None if k is None else sum(c.isalpha() for c in word[:k])
            writer.writerow([word,f,letters,'' if k is None else word[:k],kl,end_marker,other])
            n+=1;family[f]+=1;total_letters+=letters;eof+=end_marker;ambiguous+=k is None and not end_marker
            if kl is not None:counts[kl]+=1;sum_saved+=letters-kl
            if word in ['красный','красная','красные','красивый','красивее','мрачность','мрачный','мрачнеть','кот','мама','рука','ручной']:
                examples[word].append(dict(family=f,prefix='' if k is None else word[:k],k=kl,competitor=other,end_marker=end_marker))
    solved=sum(counts.values())
    fs=dict(rows=n,spellings=len({w for w,f in ordered}),families=len(family),solved=solved,solved_pct=100*solved/n,
        mean_prefix=sum(k*v for k,v in counts.items())/solved,mean_letters=total_letters/n,mean_saved=sum_saved/solved,
        eof_only=eof,homograph_unresolved=ambiguous,prefix_distribution=dict(sorted(counts.items())),
        matched_seed_lemmas=matched,within=[dict(k=k,pct=100*sum(v for a,v in counts.items() if a<=k)/n) for k in range(1,16)])
    result=dict(lemma_families=s,inflected_forms=fs,examples=examples)
    (out/'inflections_summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False)[:2000],flush=True)

if __name__=='__main__':main()
