# API

所有接口都由部署设备本地服务处理，不调用第三方API。响应默认`Cache-Control: no-store`，无CORS开放。

## B端上传

`POST /api/ingest`

请求头：

```
X-Upload-Key: 配对时生成的64位十六进制密钥
Content-Type: application/x-www-form-urlencoded
```

正文既可使用JSON，也可使用URL编码表单。

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `content` | 是 | 短信文本，1到16000字符 |
| `from` | 否 | 来源号码，最多160字符 |
| `card` | 否 | SIM卡槽信息 |
| `received_at` | 否 | B端收到短信的时间字符串，优先用于重试去重 |
| `timestamp` | 否 | 转发器时间戳，未提供接收时间时用于去重 |

请求体上限32KiB。上传成功返回：

```json
{"code":0,"success":true,"duplicate":false,"serverTime":1793000000000}
```

重复上传仍返回200，`duplicate`为true。不提供接收时间或时间戳时保留每次上传，避免误删真实的相同短信；两条真实短信若来源、卡槽、内容、接收时间都完全相同，则视为同一条。

SmsForwarder的`webParams`：

```
from=[from]&content=[org_content]&card=[card_slot]&received_at=[receive_time]&timestamp=[timestamp]
```

在自定义请求头里逐项填写，不要把整个JSON当成请求头的值。当前不需要原托管版的任何平台授权头。

## A端查看

`GET /api/state`

手机请求头：`Authorization: Bearer 查看配对密钥`。

返回最多200条最新短信、备用机名称和最近上传时间，不返回任何上传密钥或本地数据路径。无配对的远程请求返回401，上传密钥不能用于查看。

## 本机管理

真正本机回环访问`http://127.0.0.1:3210`无需密钥。容器或远程管理需要本地生成的管理配对密钥，使用同样的Authorization请求头。

管理POST接口要求同源`Origin`和JSON正文，正文上限4KiB。

| 接口 | 正文 | 用途 |
| --- | --- | --- |
| `/api/devices` | `{"name":"B手机"}` | 生成只上传配对，返回一次性密钥 |
| `/api/viewers` | `{"name":"A手机"}` | 生成只查看配对，返回一次性密钥 |
| `/api/remove-device` | `{"id":"设备ID"}` | 撤销上传密钥，同时删除此设备短信 |
| `/api/remove-viewer` | `{"id":"配对ID"}` | 撤销查看配对 |
| `/api/delete-message` | `{"id":1}` | 删除一条本地短信 |
| `/api/clear` | `{}` | 清空实例内全部短信 |
| `/api/test` | `{}` | 插入明确标注的网页测试消息 |

`GET /api/health`仅返回`{"ok":true}`，用于本地健康检查。其它路径不提供磁盘文件、数据库文件或环境变量下载。
