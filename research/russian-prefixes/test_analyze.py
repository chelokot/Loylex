"""Algorithmic checks independent of linguistic annotation quality."""
import random
import unittest
from analyze import Index

class PrefixTests(unittest.TestCase):
    def test_examples(self):
        pairs=[('красный','red'),('красная','red'),('красные','red'),('красивый','beauty'),('мрачный','gloom'),('мрачность','gloom'),('мрак','gloom')]
        i=Index(pairs)
        self.assertEqual(i.lookup('красный','red')[0],5)
        self.assertEqual(i.lookup('мрачный','gloom')[0],1)
        # With no other м- family, even м is sufficient: a full root is not required.
    def test_end_and_homograph(self):
        i=Index([('кот','cat'),('котел','boiler'),('замок','castle'),('замок','lock')])
        self.assertEqual(i.lookup('кот','cat'),(None,'котел',True))
        self.assertEqual(i.lookup('замок','castle')[0],None)
        self.assertFalse(i.lookup('замок','castle')[2])
    def test_against_brute_force(self):
        rng=random.Random(49)
        pairs=set((''.join(rng.choices('абвг',k=rng.randrange(1,9))),str(rng.randrange(8))) for _ in range(500))
        i=Index(pairs)
        for w,f in pairs:
            valid=[k for k in range(1,len(w)+1) if {g for v,g in pairs if v.startswith(w[:k])}=={f}]
            k,other,eof=i.lookup(w,f)
            self.assertEqual(k,min(valid) if valid else None)
            self.assertEqual(eof,k is None and {g for v,g in pairs if v==w}=={f})
            if other:
                self.assertTrue(any(v==other and g!=f for v,g in pairs))
                self.assertTrue(other.startswith(w[:k-1] if k else w))
    def test_family_members_do_not_compete(self):
        i=Index([('рука','hand'),('ручной','hand'),('рукав','hand'),('рубить','cut')])
        self.assertEqual(i.lookup('рука','hand')[0],3)
        self.assertEqual(i.lookup('ручной','hand')[0],3)


class SortedIndexTests(unittest.TestCase):
    def test_sorted_algorithm_matches_trie(self):
        from analyze import sorted_prefixes
        rng=random.Random(1648)
        pairs=sorted(set((''.join(rng.choices('абвг',k=rng.randrange(1,12))),str(rng.randrange(7))) for _ in range(1500)))
        index=Index(pairs)
        for word,f,k,witness,end in sorted_prefixes(pairs):
            expected,_,expected_end=index.lookup(word,f)
            self.assertEqual((k,end),(expected,expected_end))
            if witness:self.assertTrue(any(w==witness and g!=f for w,g in pairs))

class LinguisticReferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from analyze import HERE,load
        from collections import defaultdict
        data=HERE.parents[1]/'data/russian-prefix-research'
        if not (data/'root_groups.txt').exists():raise unittest.SkipTest('Run fetch_data.py for dictionary reference checks')
        morphs,core,surface,head,mapped,broad,audit=load(data)
        cls.families=defaultdict(set)
        for word,f in mapped:cls.families[word].add(f)
    def test_red_and_beauty_separate(self):
        self.assertTrue(self.families['красный'])
        self.assertTrue(self.families['красивый'])
        self.assertTrue(self.families['красный'].isdisjoint(self.families['красивый']))
    def test_root_alternations(self):
        self.assertEqual(self.families['рука'],self.families['ручной'])
        self.assertEqual(self.families['мрак'],self.families['мрачный'])
    def test_water_and_leading_separate(self):
        self.assertTrue(self.families['водный'])
        self.assertTrue(self.families['водить'])
        self.assertTrue(self.families['водный'].isdisjoint(self.families['водить']))

if __name__=='__main__':unittest.main()
