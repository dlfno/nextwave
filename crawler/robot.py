from crawler_v2 import Crawler


class robot:
    def __init__(self) -> None:
        self.crawler = Crawler()
        pass

    def search(self, query: str):
        self.crawler.search_tiktok_topic()
