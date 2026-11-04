import unittest
from app.loader import build_chunks, split_sentences
from eval.metrics import find_rank

class CoreTests(unittest.TestCase):
    def test_chinese_chunks_keep_topic(self):
        self.assertEqual(build_chunks(["配送说明\n48小时发货。满99元免运费。三至五天送达。"]), ["配送说明：48小时发货。满99元免运费。", "配送说明：三至五天送达。"])

    def test_rank_needs_topic_and_all_keywords(self):
        sources = ["配送说明：48小时发货。", "配送说明：满99元免运费。"]
        self.assertEqual(find_rank(sources, "配送说明", ["99", "免运费"]), 2)
        self.assertIsNone(find_rank(sources, "配送说明", ["99", "一年"]))

    def test_sentence_boundaries(self):
        self.assertEqual(split_sentences("甲。乙！丙？"), ["甲。", "乙！", "丙？"])

if __name__ == "__main__":
    unittest.main()
