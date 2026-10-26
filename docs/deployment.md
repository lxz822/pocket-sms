# 部署说明

## 选择部署位置

- **电脑**：最简单，安装Node.js 24后启动；电脑休眠、关机或程序退出后无法收取上传。
- **NAS / 家中小主机**：适合常开，用Node进程管理或Docker运行。
- **安卓设备**：如已有可用的Node.js 24运行环境，可在该环境运行；不同Android系统对本地网络和文件权限的限制不同，本项目未在真机验证。只有浏览器不够，浏览器不能运行服务端或读取短信。
- **iPhone**：A只用浏览器查看。当前不提供iOS服务端运行器。

## Windows、macOS、Linux

```bash
node server.mjs --lan --port 3210
```

本机管理：`http://127.0.0.1:3210`。手机必须访问部署设备的IP，不能填写`127.0.0.1`。本机管理能力来自实际回环连接，不信任`X-Forwarded-For`等请求头。

如果环境不允许自动枚举网卡，程序仍可启动；配对向导里手动填写设备IP即可。

macOS双击`.command`若提示无执行权限，终端使用`sh start-lan.command`。Windows启动脚本调用当前PATH中的`node`；请先安装Node24。

## 容器

`compose.yaml`使用命名卷持久保存数据。容器以非root的`node`用户运行。

```bash
docker compose up -d --build
docker compose exec inbox node tools/admin-link.mjs http://127.0.0.1:3210
```

如需使用宿主机目录，请自行把卷改为目录映射，并确保容器UID1000能够写入。权限错误不会通过自动放宽目录权限来绕过。

管理配对链接仅在部署设备终端按需生成，不自动写到服务日志中。其密钥保存在本地`management-key.txt`。

## 远程网络和反向代理

优先把手机接入自己部署的私人组网，使用该网络内的IP连接。没有共同可达的网络或中转，A无法凭一个网页访问家中的B或数据库；这个网络条件无法由纯HTML消除。

若使用自己的HTTPS域名：

1. 设置`PUBLIC_URL=https://sms.example.com`。
2. 保留原始`Host`请求头，代理到本地3210端口。
3. 在部署设备生成对应地址的管理链接：

```bash
node tools/admin-link.mjs https://sms.example.com
```

仅供参考的Caddy片段（域名替换为自己的）：

```caddyfile
sms.example.com {
    reverse_proxy 127.0.0.1:3210
}
```

代理配置没有随服务自动运行，不包含域名或证书申请。**不要把远程请求改写成`Host: localhost`或`Host: 127.0.0.1`**；服务的本机免登录入口只应提供给真正本机访问。不要公开代理本机管理入口。

请求使用`Authorization: Bearer ...`或`X-Upload-Key: ...`；反向代理必须保留这些请求头。服务不信任代理提供的身份或源IP。管理写请求只接受本地UI同源或显式`PUBLIC_URL`同源的JSON。

## 两人使用的正确方式

两个人各在自己的设备运行一份源码，且用不同数据目录，就天然隔离。不要共用一个实例再以为不同A手机看到的短信不同——同一实例的查看配对能够看到该实例的全部短信。

同一电脑也可以独立运行两份：

```bash
node server.mjs --lan --port 3210 --data-dir ./alice-data
node server.mjs --lan --port 3211 --data-dir ./bob-data
```

此时数据库和密钥相互独立，但两个目录都属于这台电脑的文件访问权限范围。

## 验证范围

已在Node.js 24.22.1 / Linux环境通过自动测试，包含真实HTTP服务测试。Windows/macOS启动脚本、Docker构建、手机浏览器、安卓后台保活及真实运营商短信收取，尚需用户在对应设备验证；没有用网页测试消息冒充真机收信测试。
