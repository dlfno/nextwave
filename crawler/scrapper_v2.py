import re

import pandas as pd
from bs4 import BeautifulSoup


class scrapper:
    def __init__(self, content) -> None:
        self.soup = BeautifulSoup(content, "html.parser")
        pass

    def is_commerce(self, url):
        video_name_pattern = re.compile(r"@/.")
        video_name = re.search(video_name_pattern, url)
        return video_name

    def get_metrics_tiktok_video(self, video):
        video_tittle_pattern = re.compile(r"video-desc")
        likes_pattern = re.compile(r"like-count")
        comments_pattern = re.compile(r"comment-count")
        favorite_pattern = re.compile(r"favorite-count")
        share_pattern = re.compile(r"share-count")

        video_tittle_tag = self.soup.find_all(attrs={"data-e2e": video_tittle_pattern})
        likes_tag = self.soup.find_all(attrs={"data-e2e": likes_pattern})
        comments_tag = self.soup.find_all(attrs={"data-e2e": comments_pattern})
        favorite_tag = self.soup.find_all(attrs={"data-e2e": favorite_pattern})
        share_tag = self.soup.find_all(attrs={"data-e2e": share_pattern})

        video_tittle = ""
        for elem in video_tittle_tag:
            video_tittle = video_tittle + elem.get_text()

        try:
            like_count = likes_tag[0].get_text()
            comment_count = comments_tag[0].get_text()
            favorite_count = favorite_tag[0].get_text()
            share_count = share_tag[0].get_text()
            metric_list = [
                video,
                video_tittle,
                like_count,
                comment_count,
                favorite_count,
                share_count,
            ]
            return metric_list
        except Exception as err:
            print("Error  in get_metrics_tiktok_video", err)
            return ["", "", "", "", "", ""]

    def is_comments_list(self) -> bool:
        comment_container = re.compile(r".DivCommentListContainer")
        comment_container_tag = self.soup.find_all(attrs={"class": comment_container})
        return len(comment_container_tag) > 0

    def is_comments_loaded(self) -> bool:
        username_pattern = re.compile(r"comment-username-\d+")
        return (
            True
            if len(self.soup.find_all(attrs={"data-e2e": username_pattern})) > 0
            else False
        )

    def is_unavaible_comment_section(self) -> bool:
        unavaible_container_pattern = re.compile(
            r".DivCommentsUnavailableTextContainer"
        )
        comments_without_scroll_pattern = re.compile(r".DivCommentOff")

        html_unavaible_comments_tags = self.soup.find_all(
            attrs={"class": unavaible_container_pattern}
        )
        html_comments_without_scoll_tags = self.soup.find_all(
            attrs={"class": comments_without_scroll_pattern}
        )

        return (
            len(html_unavaible_comments_tags) > 0
            or len(html_comments_without_scoll_tags) > 0
        )

    def is_empty_comment_section(self) -> bool:
        empty_container_pattern = re.compile(r".DivEmptyStateContainer")
        return (
            True
            if len(self.soup.find_all(attrs={"class": empty_container_pattern})) > 0
            else False
        )

    def is_there_captcha_pop_up(self) -> bool:
        captcha_pattern = re.compile(r"captcha.")
        captcha_tag = self.soup.find_all(attrs={"id": captcha_pattern})
        return len(captcha_tag) > 0

    def is_there_comments_button(self) -> bool:
        comment_button_pattern = re.compile(r"tux-web-tab-bar")
        comment_button_tag = self.soup.find_all(
            attrs={"data-testid": comment_button_pattern}
        )
        print(comment_button_tag)
        return len(comment_button_tag) > 0

    def get_more_replies_html(self):
        more_replies_pattern = re.compile(r".DivViewMoreRepliesWrapper")
        replies_html_elements = []
        try:
            for html_element_replies in self.soup.find_all(
                attrs={"class": more_replies_pattern}
            ):
                replies_html_elements.append(html_element_replies.find("button"))
                print(html_element_replies.find("button"))
        except Exception as err:
            print("Something faild ", err)
            return []
        return replies_html_elements

    def count_comments(self) -> int:
        try:
            comment_pattern = re.compile(r"comment-level-\d+")
            return len(self.soup.find_all(attrs={"data-e2e": comment_pattern}))
        except Exception as err:
            return 0

    def get_comments(self, video) -> list:
        users_comments = []
        username_pattern = re.compile(r"comment-username-\d+")
        comment_pattern = re.compile(r"comment-level-\d+")
        try:
            for user, comment in zip(
                self.soup.find_all(attrs={"data-e2e": username_pattern}),
                self.soup.find_all(attrs={"data-e2e": comment_pattern}),
            ):
                comment_level = comment["data-e2e"][-1:]
                comment_text = re.sub(r"\s+", " ", comment.get_text()).strip()
                comment_username = user.find(href=True)["href"][1:]
                users_comments.append(
                    [comment_level, comment_text, comment_username, video]
                )

            return users_comments
        except Exception as err:
            print("Something faild ", err)

        return ["", "", "", video]

    def get_usernames(self) -> set:
        users = set()
        username_pattern = re.compile(r"comment-username-\d+")
        try:
            for user in self.soup.find_all(attrs={"data-e2e": username_pattern}):
                users.add(user.find(href=True)["href"][1:])

        except Exception as err:
            print("Something faild ", err)

        return users

    def is_grid_video_loaded(self) -> bool:
        video_container_pattern = re.compile(r"grid-item-container.")
        return (
            True
            if len(self.soup.find_all(attrs={"id": video_container_pattern})) > 0
            else False
        )

    def get_video_list(self) -> list:
        video_list = []
        video_list_pattern = re.compile(r"search_video-item-list")
        video_link_pattern = re.compile(r".AVideoContainer")
        video_container_pattern = re.compile(r"grid-item-container.")

        try:
            for video_container in self.soup.find_all(
                attrs={"id": video_container_pattern}
            ):
                video_list.append(
                    video_container.find(attrs={"class": video_link_pattern})["href"]
                )

        except Exception as err:
            print("Something faild ", err)
            return []

        print(video_list)
        return video_list
