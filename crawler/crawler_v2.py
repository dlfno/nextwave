import time
import random
import datetime as dt
import os
import pandas as pd
import copy
import requests

from selenium import webdriver
from selenium.webdriver.firefox.options import Options as FirefoxOptions
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import (
    TimeoutException,
    NoSuchElementException,
    WebDriverException,
)

from selenium.webdriver import ActionChains
from selenium.webdriver.common.actions.wheel_input import ScrollOrigin


class Crawler:
    def __init__(self):
        try:
            opts = FirefoxOptions()
            opts.page_load_strategy = "normal"
            opts.set_preference(
                "general.useragent.override",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
            )
            self.driver = webdriver.Firefox(options=opts)
        except Exception as err:
            print("Something was wrong")

    """
    def search_tiktok_topic(self, url):
        try:
            self.driver.get(url)
            html_content = self.driver.page_source
            scrapy_doo = scrapper(html_content)
            video_list = scrapy_doo.get_video_list()
            while len(video_list) == 0:
                html_content = self.driver.page_source
                scrapy_doo = scrapper(html_content)
                video_list = scrapy_doo.get_video_list()
                time.sleep(3)
            self.video_list = video_list
            self.driver.save_full_page_screenshot("full_page_screenshot.png")
        except Exception as err:
            print("Something was wrong", err)

    def see_more_comments(self):
        try:
            scrapper_obj = scrapper(self.driver.page_source)

            more_comments_buttons = self.driver.find_elements(
                By.XPATH,
                "//button[@class='TUXButton TUXButton--borderless TUXButton--xsmall TUXButton--secondary' and contains(., 'Ver') and contains(., 'respuestas')]",
            )
            more_comments_span = self.driver.find_elements(
                By.XPATH,
                "//span[@class='TUXText TUXText--tiktok-sans TUXText--weight-medium' and contains(., 'Ver') and contains(., 'respuestas')]",
            )

            t0_comments = 0
            t1_comments = 1
            while t0_comments < t1_comments:
                for button in more_comments_buttons:
                    print(
                        f"Buttons text: {button.text}, lens: {len(more_comments_buttons)}"
                    )
                    button.click()
                    time.sleep(random.uniform(3, 6))
                    self.wait_until_solve_captcha()

                for span in more_comments_span:
                    print(f"Spans text: {span.text}, lens: {len(more_comments_span)}")
                    span.click()
                    time.sleep(random.uniform(3, 6))
                    self.wait_until_solve_captcha()

                more_comments_buttons = self.driver.find_elements(
                    By.XPATH,
                    "//button[@class='TUXButton TUXButton--borderless TUXButton--xsmall TUXButton--secondary' and contains(., 'Ver') and contains(., 'respuestas')]",
                )
                more_comments_span = self.driver.find_elements(
                    By.XPATH,
                    "//span[@class='TUXText TUXText--tiktok-sans TUXText--weight-medium' and contains(., 'Ver') and contains(., 'más')]",
                )

                print(f"After first it, button lens: {len(more_comments_buttons)}")
                print(f"After first it, span lens: {len(more_comments_span)}")
                t0_comments = t1_comments
                t1_comments = scrapper_obj.count_comments()
                print(f"comments t0 button lens: {t0_comments}")
                print(f"comments t1 span lens: {t1_comments}")

        except Exception as err:
            print("Error in see_more_comments", err)

    def wait_until_solve_captcha(self):
        scrapper_obj = scrapper(self.driver.page_source)
        if scrapper_obj.is_there_captcha_pop_up():
            input()

    def scroll_in_comments(self):
        try:
            y_delta = int(random.uniform(600, 800))
            scroll_comment_tag = self.driver.find_elements(
                By.CSS_SELECTOR, "div[class='.DivCommentListContainer*']"
            )
            print(scroll_comment_tag)
            ActionChains(self.driver).scroll_by_amount(0, y_delta).perform()
        except Exception as err:
            print("scroll_in_comments", err)

    def navigate_to_comments(self):
        try:
            comment_button_tag = self.driver.find_element(
                By.XPATH,
                "button[class='TUXButton TUXButton--borderless TUXButton--xsmall TUXButton--secondary']",
            )
            time.sleep(random.uniform(1, 4))
            comment_button_tag.click()
        except Exception as err:
            print("Error in see_more_comments", err)

    def see_tiktok_video(self, url):
        self._human_delay()
        users = set()
        metrics = []
        comments = []
        try:
            self.driver.get(url)
            scrapper_obj = scrapper(self.driver.page_source)
            while True:
                scrapper_obj = scrapper(self.driver.page_source)
                users = scrapper_obj.get_usernames()
                metrics = scrapper_obj.get_metrics_tiktok_video(url)
                time.sleep(10)
                scrapper_obj = scrapper(self.driver.page_source)

                if scrapper_obj.is_there_captcha_pop_up():
                    print("Wait until solve captcha")
                    dummy = input()

                time.sleep(5)
                scrapper_obj = scrapper(self.driver.page_source)

                if (
                    scrapper_obj.is_empty_comment_section()
                    or scrapper_obj.is_unavaible_comment_section()
                ):
                    print("There is not comments")
                    input()
                    break

                if (
                    not scrapper_obj.is_empty_comment_section()
                    and scrapper_obj.is_comments_loaded()
                ):
                    print("Waiting to download comments")
                    input()
                    scrapper_obj = scrapper(self.driver.page_source)
                    self.scroll_in_comments()
                    self.see_more_comments()
                    metrics = scrapper_obj.get_metrics_tiktok_video(url)
                    comments = scrapper_obj.get_comments(url)
                    break

            print(self.driver.current_url)
            print(metrics)
            print(users)
            print(comments)
        except Exception as err:
            print("Something was wrong", err)

        return (users, metrics, comments)

    def explore_videos(self):
        videos = copy.deepcopy(self.video_list)
        users = set()
        metrics = []
        comments = []
        while len(self.video_list) > 0:
            video = self.video_list.pop()
            u, m, c = self.see_tiktok_video(video)
            users = users.union(u)
            metrics.append(m)
            comments.extend(c)

        print(users)
        print(videos)
        print(metrics)
        print(comments)

        time_now_dir = dt.datetime.now().isoformat(timespec="minutes")
        os.mkdir(f"../data/{time_now_dir}")

        users_dataframe = pd.DataFrame({"users": list(users)})
        videos_dataframe = pd.DataFrame({"videos": videos})
        metrics_dataframe = pd.DataFrame(
            metrics,
            columns=["video", "tittle", "likes", "comments", "favorite", "share"],
        )
        comments_dataframe = pd.DataFrame(
            comments, columns=["level", "text", "username", "video"]
        )

        users_dataframe.to_csv(
            f"../data/{time_now_dir}/users.csv", index=False, sep="\t"
        )
        videos_dataframe.to_csv(
            f"../data/{time_now_dir}/videos.csv", index=False, sep="\t"
        )
        metrics_dataframe.to_csv(
            f"../data/{time_now_dir}/metrics.csv", index=False, sep="\t"
        )
        comments_dataframe.to_csv(
            f"../data/{time_now_dir}/comments.csv", index=False, sep="\t"
        )
    """

    def _human_delay(self):
        time.sleep(random.uniform(1, 10))

    def search(self, query: str):
        self.driver.get("https://duckduckgo.com/?q=" + requests.utils.quote(query))


if __name__ == "__main__":
    url = "https://www.tiktok.com/search?q=paljale"
    ob_crawler = Crawler()
    ob_crawler.search("tiendas de audio")
