#!/usr/bin/env python3
import collections,csv,gzip,json,statistics
from analyze import HERE,load,compute,Index

def main():
    out=HERE/'results';data=HERE.parents[1]/'data/russian-prefix-research'
    morphs,*_=load(data)
    with gzip.open(out/'lemma_families.csv.gz','rt',encoding='utf-8-sig') as h:rows=list(csv.DictReader(h))
    _,individual=compute('individual_words',[(r['word'],r['word']) for r in rows],morphs,out)
    prefixes=collections.defaultdict(set)
    for r in rows:
        for k in range(1,min(6,len(r['word']))+1):prefixes[r['word'][:k]].add(r['family'])
    top={str(k):[dict(prefix=p,families=len(fs)) for p,fs in sorted(prefixes.items(),key=lambda x:(-len(x[1]),x[0])) if len(p)==k][:10] for k in [2,3,4,5]}
    depth=[]
    for k in range(1,9):
        counts=[len(prefixes[r['word'][:k]]) for r in rows if len(r['word'])>=k] if k<=6 else []
        if counts:depth.append(dict(k=k,median_candidates=statistics.median(counts)))
    finite=[r for r in rows if r['prefix_letters']]
    longs=sorted(finite,key=lambda r:(-int(r['prefix_letters']),r['word']))[:15]
    saves=sorted(finite,key=lambda r:(-(int(r['word_letters'])-int(r['prefix_letters'])),r['word']))[:15]
    bins=[]
    for a,b in [(1,4),(5,7),(8,10),(11,13),(14,100)]:
        rs=[r for r in rows if a<=int(r['word_letters'])<=b];sol=[r for r in rs if r['prefix_letters']]
        bins.append(dict(label=f'{a}–{b}' if b!=100 else '14+',n=len(rs),mean_word=statistics.mean(int(r['word_letters']) for r in rs),mean_prefix=statistics.mean(int(r['prefix_letters']) for r in sol),solved_pct=100*len(sol)/len(rs)))
    result=dict(individual_words=individual,ambiguous_prefixes=top,remaining_candidates=depth,longest=longs,largest_savings=saves,length_bins=bins)
    (out/'extra_summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')

if __name__=='__main__':main()
