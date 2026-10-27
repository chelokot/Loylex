#!/usr/bin/env python3
"""Finite-dictionary identification research; no NLP models or executable downloads."""
from __future__ import annotations
import argparse, collections, csv, gzip, hashlib, json, random, re, statistics, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CYR = re.compile(r'[а-яё]+(?:-[а-яё]+)*\Z')

def norm(s):
    return s.lower().replace('ё', 'е').replace('\u0301', '')

def parse_morphs(text):
    out=[]; position=0
    for part in text.split('/'):
        if ':' not in part: return []
        value, kind=part.rsplit(':',1)
        value=norm(value)
        out.append((value,kind,position,position+len(value)))
        position+=len(value)
    return out

class Index:
    """Trie storing at most two distinct owners and witnesses per node (exact)."""
    def __init__(self, pairs):
        self.children=[{}]; self.owners=[[]]; self.exact={}
        for word,family in sorted(set(pairs)):
            self.exact.setdefault(word,set()).add(family)
            node=0
            self.add(node,family,word)
            for letter in word:
                nxt=self.children[node].get(letter)
                if nxt is None:
                    nxt=len(self.children);self.children[node][letter]=nxt
                    self.children.append({});self.owners.append([])
                node=nxt;self.add(node,family,word)
    def add(self,node,family,word):
        owners=self.owners[node]
        if len(owners)<2 and all(family!=f for f,w in owners):owners.append((family,word))
    def lookup(self,word,family):
        node=0; previous=0
        for k,letter in enumerate(word,1):
            previous=node;node=self.children[node][letter]
            if len(self.owners[node])==1 and self.owners[node][0][0]==family:
                other=next((w for f,w in self.owners[previous] if f!=family),'')
                return k,other,False
        other=next((w for f,w in self.owners[node] if f!=family),'')
        return None,other,len(self.exact[word])==1

def quantile(values,p):
    a=sorted(values)
    return a[max(0,min(len(a)-1,int((len(a)-1)*p)))] if a else None

def summary(rows):
    solved=[r for r in rows if r['prefix_letters'] is not None]
    sizes=collections.Counter(r['family'] for r in rows)
    groups=collections.defaultdict(list)
    for r in solved:groups[r['family']].append(r['prefix_letters'])
    n=len(rows)
    return dict(rows=n,spellings=len({r['word'] for r in rows}),families=len(sizes),
        singletons=sum(v==1 for v in sizes.values()),solved=len(solved),
        solved_pct=100*len(solved)/n,mean_letters=statistics.mean(r['word_letters'] for r in rows),
        mean_prefix=statistics.mean(r['prefix_letters'] for r in solved),
        median_prefix=statistics.median(r['prefix_letters'] for r in solved),
        p90_prefix=quantile([r['prefix_letters'] for r in solved],.9),
        family_balanced_mean=statistics.mean(statistics.mean(a) for a in groups.values()),
        mean_suffix=statistics.mean(r['suffix_letters'] for r in rows if r['suffix_letters'] is not None),
        mean_saved=statistics.mean(r['word_letters']-r['prefix_letters'] for r in solved),
        eof_only=sum(r['needs_end_marker'] for r in rows),
        homograph_unresolved=sum(r['prefix_letters'] is None and not r['needs_end_marker'] for r in rows),
        prefix_distribution=dict(sorted(collections.Counter(r['prefix_letters'] for r in solved).items())),
        within=[dict(k=k,pct=100*sum(r['prefix_letters'] is not None and r['prefix_letters']<=k for r in rows)/n) for k in range(1,16)],
        largest_families=[dict(family=f,size=v) for f,v in sizes.most_common(15)])

def compute(name,pairs,morphs,out):
    pairs=sorted(set(pairs));index=Index(pairs);rev=Index((w[::-1],f) for w,f in pairs)
    rows=[]
    for word,family in pairs:
        k,other,eof=index.lookup(word,family)
        suffix,_,_=rev.lookup(word[::-1],family)
        options=morphs.get(word,[])
        roots_options={tuple((s,a,b) for s,t,a,b in parts if t=='ROOT') for parts in options}
        roots=next(iter(roots_options)) if len(roots_options)==1 else ()
        root=roots[0] if len(roots)==1 else None
        relation='unknown_or_multiple_roots'
        if root:
            value,a,b=root
            if k is None:relation='no_prefix'
            elif a==0 and k==b:relation='exact_root'
            elif k<b:relation='before_root_end'
            elif k==b:relation='prefix_plus_root'
            else:relation='after_root_end'
        r=dict(dataset=name,word=word,family=family,word_letters=sum(c.isalpha() for c in word),
            word_characters=len(word),prefix='' if k is None else word[:k],prefix_letters=None if k is None else sum(c.isalpha() for c in word[:k]),prefix_characters=k,
            suffix='' if suffix is None else word[-suffix:],suffix_letters=None if suffix is None else sum(c.isalpha() for c in word[-suffix:]),
            needs_end_marker=eof,competitor=other,roots='+'.join(x[0] for x in roots),
            root_start='' if not root else root[1],root_end='' if not root else root[2],
            root_letters='' if not root else len(root[0]),root_relation=relation,
            morphemes=' | '.join('/'.join(f'{s}:{t}' for s,t,a,b in parts) for parts in options))
        rows.append(r)
    s=summary(rows)
    s['root_relations']=dict(collections.Counter(r['root_relation'] for r in rows))
    s['root_annotated']=sum(bool(r['morphemes']) for r in rows)
    with gzip.open(out/f'{name}.csv.gz','wt',encoding='utf-8-sig',newline='') as h:
        writer=csv.DictWriter(h,fieldnames=list(rows[0]));writer.writeheader();writer.writerows(rows)
    print(name,json.dumps(s,ensure_ascii=False)[:500],flush=True)
    return rows,s

def mapped_families(data, morphs):
    # Etymological IDs are used only when their SURFACE root agrees with the modern segmentation.
    canonical={}
    for line in (data/'root_groups.txt').read_text().splitlines():
        if '→' in line:
            a,b=map(str.strip,line.split('→'));canonical[norm(a)]=norm(b)
        else:
            variants=[norm(x.strip()) for x in line.split('/') if x.strip()]
            for x in variants:canonical[x]=variants[0]
    def resolve(x):
        seen=set()
        while x in canonical and canonical[x]!=x and x not in seen:
            seen.add(x);x=canonical[x]
        return x
    def bare(x):return re.sub('[^а-яе]', '', norm(x))
    possible=collections.defaultdict(set)
    for x in canonical:possible[bare(x)].add(resolve(x))
    lexical=collections.defaultdict(set)
    for line in (data/'lemmas_to_roots.tsv').read_text().splitlines():
        if '\t' not in line:continue
        word,roots=line.split('\t',1)
        match=re.match(r'[а-яё\u0301-]+',word.lower())
        if not match:continue
        word=norm(match.group())
        # Keep only unambiguously single-root source records.
        if re.fullmatch(r'[а-яё¹²³⁴⁵⁶⁷⁸⁹⁰]+',roots):lexical[word].add(norm(roots))
    # Resolve a homonymous surface root only when a Tikhonov nest supplies exactly one candidate ID.
    known={}
    for word,options in morphs.items():
        roots={s for parts in options for s,t,a,b in parts if t=='ROOT'}
        known[word]={resolve(x) for x in lexical[word] if bare(x) in roots}
    neighbours=collections.defaultdict(set)
    with zipfile.ZipFile(data/'nests.zip') as z:nests=json.loads(z.read('nests.json'))
    for nest in nests:
        for items in nest.values():
            members=[]
            for item in items:
                w=norm(re.sub(r'\s+(?:[IVX]+|\d+)$','',item['root']).split('/')[-1])
                if w in morphs:members.append(w)
            anchors=set().union(*(known[w] for w in members)) if members else set()
            for w in members:neighbours[w].update(anchors)
    pairs=[];audit=collections.Counter()
    for word,options in morphs.items():
        for parts in options:
            root=next(s for s,t,a,b in parts if t=='ROOT')
            direct={resolve(x) for x in lexical[word] if bare(x)==root}
            if direct:
                ids={'K:'+x for x in direct};audit['direct_surface_agreement']+=1
            elif len(possible[root])==1:
                ids={'K:'+next(iter(possible[root]))};audit['unique_variant_inference']+=1
            elif len(possible[root] & neighbours[word])==1:
                ids={'K:'+next(iter(possible[root] & neighbours[word]))};audit['nest_disambiguation']+=1
            else:
                ids={'R:'+root};audit['unmapped_or_homonymous_variant']+=1
            pairs.extend((word,x) for x in ids)
    return pairs,dict(audit)

def load(data):
    morphs=collections.defaultdict(list);bad=0
    for line in (data/'rumorphs-lemmas.txt').read_text().splitlines():
        word,analysis=line.split('\t',1);word=norm(word);parts=parse_morphs(analysis)
        if not CYR.fullmatch(word) or ''.join(x[0] for x in parts)!=word or not any(x[1]=='ROOT' for x in parts):bad+=1;continue
        if parts not in morphs[word]:morphs[word].append(parts)
    # Original printed dictionary is also used to reject malformed OCR nest tokens.
    vocabulary=set(morphs)
    for line in (data/'tikhonovsource.txt').read_text().splitlines():
        word=norm(line.split(' | ',1)[0])
        if CYR.fullmatch(word):vocabulary.add(word)
    # Two source-supported examples absent from the labelled release. Never infer all roots from spelling.
    corrections={'красный':'красн:ROOT/ый:END','мрачность':'мрач:ROOT/н:SUFF/ость:SUFF'}
    for word,analysis in corrections.items():morphs[word].append(parse_morphs(analysis));vocabulary.add(word)
    with zipfile.ZipFile(data/'nests.zip') as z:nests=json.loads(z.read('nests.json'))
    core=[];labels={};raw_nest_words=0
    for i,nest in enumerate(nests):
        for base,items in nest.items():
            f=f'T{i:04}:{norm(base)}';labels[f]=norm(base)
            for item in items:
                raw_nest_words+=1
                word=item['root'].replace('\u0301','')
                word=re.sub(r'\s+(?:[IVX]+|\d+)$','',word)
                word=norm(word.split('/')[-1])
                if word in vocabulary and CYR.fullmatch(word):core.append((word,f))
    surface=[];head=[]
    for word,options in morphs.items():
        for parts in options:
            roots=[s for s,t,a,b in parts if t=='ROOT']
            surface.append((word,'+'.join(roots)));head.append((word,roots[0]))
    broad=[];broad_all=[];broad_capitals=0;malformed=0
    for line in gzip.open(HERE/'inputs/UDer-1.1-ru-DeriNetRU.tsv.gz','rt'):
        if not line.strip():continue
        columns=line.rstrip('\n').split('\t');node,word=columns[0],columns[2]
        f='D'+node.split('.')[0];w=norm(word)
        broad_all.append((w,f))
        if not CYR.fullmatch(w):malformed+=1;continue
        if word!=word.lower():broad_capitals+=1;continue
        broad.append((w,f))
    audit=dict(rumorphs_input_rows=96036,rumorphs_bad_rows=bad,morph_spellings=len(morphs),
        corrections=corrections,raw_nests=len(nests),raw_nest_rows=raw_nest_words,
        broad_input_rows=len(broad_all),broad_capitalized_removed=broad_capitals,broad_malformed_removed=malformed)
    mapped,mapped_audit=mapped_families(data,morphs)
    audit['mapped_assignment']=mapped_audit
    return morphs,core,surface,head,mapped,broad,audit

def experiment_size(pairs):
    # Fixed targets are present at every dictionary size; added competitors never disappear.
    pairs=sorted(set(pairs));rng=random.Random(1648);rng.shuffle(pairs)
    targets=pairs[:min(2000,len(pairs))];results=[]
    for fraction in [.1,.25,.5,1.0]:
        sample=pairs[:max(len(targets),int(len(pairs)*fraction))];index=Index(sample)
        lengths=[index.lookup(w,f)[0] for w,f in targets]
        results.append(dict(dictionary_rows=len(sample),targets=len(targets),
            mean_finite=statistics.mean(k for k in lengths if k is not None),
            unresolved=sum(k is None for k in lengths),
            penalized_mean_characters=statistics.mean(k if k is not None else len(w)+1 for (w,f),k in zip(targets,lengths))))
    return results

def lcp(a,b):
    i=0
    for x,y in zip(a,b):
        if x!=y:break
        i+=1
    return i

def sorted_prefixes(pairs):
    """Nearest different-owner neighbours suffice in lexicographic order."""
    n=len(pairs);start=0
    while start<n:
        end=start+1
        while end<n and pairs[end][1]==pairs[start][1]:end+=1
        for i in range(start,end):
            word,family=pairs[i];candidates=[]
            if start:candidates.append(pairs[start-1][0])
            if end<n:candidates.append(pairs[end][0])
            if candidates:
                other=max(candidates,key=lambda x:lcp(word,x)); k=lcp(word,other)+1
            else:other='';k=1
            homograph=(i>0 and pairs[i-1][0]==word and pairs[i-1][1]!=family) or (i+1<n and pairs[i+1][0]==word and pairs[i+1][1]!=family)
            yield word,family,k if k<=len(word) else None,other,k>len(word) and not homograph
        start=end


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--data',type=Path,default=HERE.parents[1]/'data/russian-prefix-research');ap.add_argument('--out',type=Path,default=HERE/'results');args=ap.parse_args();args.out.mkdir(parents=True,exist_ok=True)
    morphs,core,surface,head,mapped,broad,audit=load(args.data)
    all_stats={};all_rows={}
    for name,pairs in [('mapped_roots',mapped),('tikhonov_nests',core),('surface_roots',surface),('first_root',head),('derinet_broad',broad)]:
        rows,s=compute(name,pairs,morphs,args.out);all_stats[name]=s
        if name!='derinet_broad':all_rows[name]=rows
    all_stats['audit']=audit;all_stats['dictionary_size']=experiment_size(surface)
    examples={}
    for w in ['красный','красивый','мрачный','мрачность','мрачнеть','рука','ручной','кот','водный','водить','прекрасный','безопасность','электрификация','абажур','мама','стол']:
        examples[w]={name:[r for r in rows if r['word']==w] for name,rows in all_rows.items()}
    (args.out/'examples.json').write_text(json.dumps(examples,ensure_ascii=False,indent=2)+'\n')
    (args.out/'summary.json').write_text(json.dumps(all_stats,ensure_ascii=False,indent=2)+'\n')
    # A per-family export keeps every member and its result; no arbitrary representative is used for means.
    for name,rows in all_rows.items():
        fam=collections.defaultdict(list)
        for r in rows:fam[r['family']].append(r)
        with gzip.open(args.out/f'{name}_families.jsonl.gz','wt') as h:
            for f,rs in sorted(fam.items()):
                solved=[r['prefix_letters'] for r in rs if r['prefix_letters'] is not None]
                h.write(json.dumps(dict(family=f,members=[r['word'] for r in rs],size=len(rs),min_prefix=min(solved) if solved else None,max_prefix=max(solved) if solved else None,mean_prefix=statistics.mean(solved) if solved else None,unresolved=sum(r['prefix_letters'] is None for r in rs)),ensure_ascii=False)+'\n')

if __name__=='__main__':main()
