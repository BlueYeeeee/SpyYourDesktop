<p align="right">中文 | <a href="./README.en.md">English</a></p>

本项目受到 https://github.com/sleepy-project/sleepy 和 https://github.com/anyans/lookme 启发，并基于后者修改完成<br>
>其实基本都是把要求告诉AI让AI改的<br>
# 网站部署教程<br>
先下载Web，如果要换成最新的前端，再下Web(new)里面的文件，覆盖即可<br>
区别：老版本是一个设备一个页面；新版本是根据ID去分类machine-id，来做到直接加载一个人的全部设备（新版本单人单提交token，防止提交数据乱窜，建议用新版）<br>
~~你不会连Nodejs都不会安装吧~~<br>开玩笑的，真的不会装请问AI，他都会教你怎么弄的（~~你不会连cmd和linux终端都不会用吧~~）<br>
网站部署后将目录更改为public，然后cd到**解压后目录（不是Public）**，执行`npm i`，安装依赖后`npm start`，然后去宝塔的软件商店下载PM2，添加项目，运行文件为目录下的server.js，其他会自动补全，然后点保存即可监听（端口冲突自行修改）<br>**注意千万不要把域名/IP+端口挂在网站域名下，这样就被ngnix监听了！你是要让Nodejs监听端口**<br>
网站的背景请在public文件夹下添加“wallpaper有耳朵抖动.jpg”，第一个按钮的图标是“favicon.ico”。<br>
上面的文件名都可以在html文件里改成你想要的，方便之后替换<br>

服务器配置和 API 接口，请参阅[API.md](Web(new)/API.md)

## 新版本多的功能<br>
支持根据machine-id修改显示的名字，在`group-map.json`文件，按照示例修改即可<br>
单人单密钥在`name-keys.json`改
# Windows侧视奸教程（NEW）<br>
下载Release里面的exe文件即可（没有运行环境的话去下.net 8.0）<br>
# Windows侧视奸教程（OLD）（不推荐）<br>
~~你不会连Nodejs都不会安装吧<br>同样在解压目录下运行cmd(不知道这句话什么意思问AI)，执行`npm i`，安装依赖后`npm start`，然后修改SERVER_URL=到你要上报的地址加端口（两边的PORT保持一致），基本就没问题了<br>Win+R，输入shell:startup，把Windows文件夹下的start-seeme.bat丢进去就可以开机自启<br>~~
# iOS侧视奸教程<br>
导入此快捷指令 https://www.icloud.com/shortcuts/844188bc2e714e3db99b3881c6bfa5d0 ，修改密钥和machine-id。完成后去自动化-创建个人自动化-打开App-（选择**一个**App）-（新建空白自动化）-搜索添加第一步：文本-输入这个App名称-搜索添加第二步：运行快捷指令-（选择刚才导入的）-关闭运行前询问/始终运行<br>iOS要视奸多个App要分开加快捷指令
# 安卓侧视奸教程<br>
https://github.com/RewLight/foreground-monitor
# Linux侧视奸教程<br>
到 [Releases](https://github.com/QQ1816/SpyYourDesktop/releases/latest) 下载 Linux 客户端：`spy-your-desktop`（无后缀单文件，推荐）或 `spy-your-desktop_1.0.0_amd64.deb`（deb 包）。<br>
deb 安装：`sudo apt install ./spy-your-desktop_1.0.0_amd64.deb`；单文件：`chmod +x spy-your-desktop` 后可直接运行，也可 `sudo install -m 0755 spy-your-desktop /usr/local/bin/spy-your-desktop`。<br>
然后执行 `spy-your-desktop init`，按提示填写服务器上报地址（`http://服务器IP:3000/api/ingest`）、设备 ID（必须已加入服务端 `group-map.json` 对应名字的名单）和上传密钥（`name-keys.json` 里的 key）；再执行 `spy-your-desktop test` 验证能否上传，成功后用 `spy-your-desktop start` 后台运行。`spy-your-desktop stop` 随时停止，`spy-your-desktop privacy on` 只上报占位内容，`spy-your-desktop autostart install` 设置登录自启动。<br>
Linux 客户端不修改服务端任何代码或配置，只上报当前前台窗口标题和应用名，不上传截图、键盘输入、剪贴板或文件内容。Wayland 下能否读取前台窗口取决于桌面环境是否提供接口，各桌面支持情况见 [Linux/README.md](Linux/README.md)。<br>
**GNOME Wayland 用户注意：新版 GNOME 需要先安装并启用 [Focused Window D-Bus](https://extensions.gnome.org/extension/5592/focused-window-d-bus/) 扩展，否则客户端读不到原生 Wayland 前台窗口，通常只能看到 XWayland 应用；不装扩展时请改用 “GNOME on Xorg” 会话。**<br>
**声明：Linux客户端只在Ubuntu 26.04的kde-wayland桌面环境测试通过**；其他桌面环境、发行版和架构均未实测。<br>
# 作者运行环境声明<br>
服务器使用宝塔面板，nodejs版本为v12；电脑为Windows 10；iOS15.7（安装巨魔）；通过tailscale上报状态（实测直接用域名上报也可以）
# 声明<br>
本项目仅供学习交流，禁止用于商业行为
