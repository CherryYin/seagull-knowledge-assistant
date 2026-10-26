from datetime import date

import httpx
from pydantic import ValidationError

from pkg.schemas.application.wechat_statistics import WechatStatisticsPayload

WECHAT_BASE = "https://api.weixin.qq.com"


class WechatStatisticsError(RuntimeError):
    def __init__(self, detail: str, status_code: int = 502):
        super().__init__(detail)
        self.status_code = status_code


async def _json(response: httpx.Response) -> dict:
    try:
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError):
        raise WechatStatisticsError("微信统计请求失败，请检查网络后手动重试；历史快照未被覆盖") from None
    if not isinstance(payload, dict):
        raise WechatStatisticsError("微信返回格式异常，未保存统计数据")
    code = payload.get("errcode")
    if code is not None and type(code) is not int:
        raise WechatStatisticsError("微信返回错误码格式异常，未保存统计数据")
    if code not in (None, 0):
        known = {
            40013: "公众号 AppID 无效", 40125: "公众号 AppSecret 无效",
            40164: "请将 PKG 服务器的公网出口 IP 加入公众号接口 IP 白名单",
            48001: "该公众号没有此统计接口权限，请检查后台接口权限；已认证不代表所有接口均可用",
            48004: "公众号接口已被禁用，请检查公众号后台",
            45009: "微信接口调用次数已达上限，请稍后手动重试",
            45011: "微信接口调用过于频繁，请稍后手动重试",
            89503: "此服务器 IP 的首次调用需要公众号管理员确认，请检查微信提示",
            89506: "公众号管理员已拒绝此 IP 的调用，请先与管理员核对",
            89507: "公众号管理员已拒绝此 IP 的调用，请先与管理员核对",
            40001: "微信 access_token 无效，请检查账号配置及其他使用此账号的系统",
            42001: "微信 access_token 已过期，请手动重新同步",
            61500: "微信拒绝了日期格式", 61501: "微信拒绝了日期范围；每次只查询一个发表日期",
        }
        raise WechatStatisticsError(known.get(code, "微信统计接口返回错误，未保存数据；请检查后台接口权限与配额"), status_code=429 if code in (45009, 45011) else 502)
    return payload


async def fetch_article_statistics(*, app_id: str, app_secret: str, publication_date: date, client: httpx.AsyncClient) -> WechatStatisticsPayload:
    try:
        token_response = await client.post(f"{WECHAT_BASE}/cgi-bin/stable_token", json={
            "grant_type": "client_credential", "appid": app_id, "secret": app_secret, "force_refresh": False,
        })
        token = (await _json(token_response)).get("access_token")
        if not isinstance(token, str) or not token:
            raise WechatStatisticsError("微信未返回有效访问令牌，未查询统计数据")
        response = await client.post(f"{WECHAT_BASE}/datacube/getarticletotaldetail", params={"access_token": token}, json={
            "begin_date": publication_date.isoformat(), "end_date": publication_date.isoformat(),
        })
        payload = WechatStatisticsPayload.model_validate(await _json(response))
        if any(item.ref_date != publication_date for item in payload.list) or len({item.msgid for item in payload.list}) != len(payload.list):
            raise WechatStatisticsError("微信返回的文章范围异常，未保存统计数据")
        return payload
    except httpx.HTTPError:
        raise WechatStatisticsError("连接微信失败或超时，未保存数据；请手动重试") from None
    except ValidationError:
        raise WechatStatisticsError("微信统计数据格式异常，未保存数据；缺失数据不会当作零") from None
