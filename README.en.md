<p align="right"><a href="./README.md">中文</a> | English</p>
This project is inspired by https://github.com/sleepy-project/sleepy and https://github.com/anyans/lookme , and is modified based on the latter.<br>

> Honestly, most of it was just telling the AI what I wanted and letting it make the changes.<br>

# Website Deployment Guide<br>

First download **Web**, then download the files inside **Web(new)** and overwrite the previous ones (remember to rename `index(English ver.).html` to `index.html`).<br>
If you don’t overwrite, the webpage will be in Chinese.<br>
After deployment, set the directory to **public**, then `cd` into the **extracted directory (not Public)** and run `npm i` to install dependencies, then `npm start`. Next, in BaoTa’s app store, download **PM2**, add a project, set the entry file to `server.js` in the directory, other fields will auto-complete, then click Save to start listening (change the port yourself if there’s a conflict).<br>**Note: Do NOT attach your domain/IP+port under the site’s domain; that would put it behind ngnix! You want Node.js to listen on the port.**<br>
For the site background, add `background.jpg` under the `public` folder.<br>
All of the above filenames can be changed in the HTML files to whatever you prefer for easier replacement later.<br>
You can change the displayed name by `machine-id` in `group-map.json`—just follow the example.<br>
For single-user single-key, edit `name-keys.json`.<br>
PS:I don't know what operations can achieve the same monitoring effect without PM2, so you have to explore this on your own. My apology :)<br>

For configuration and API endpoints, please take a look: [API.md](/Web(new)/API.md)

# Windows Guide(OLD)<br>

Likewise, open **cmd** in the extracted directory (~~if you’re not sure what that means, ask an AI~~), run `npm i` to install dependencies, then `npm start`. After that, change `SERVER_URL=` to the address and port you want to report to (**keep the PORT the same on both sides**), and you should be good to go.<br>
Press **Win+R**, type `shell:startup`, and drop `start-seeme.bat` (under the Windows folder in this project) into that Startup folder to enable launch at boot.<br>

# Windows Guide（NEW）<br>
Just download the .exe in the Release folder (if you don’t have the runtime, install .NET 8.0).<br>

# iOS Guide<br>

Import this Shortcut: https://www.icloud.com/shortcuts/844188bc2e714e3db99b3881c6bfa5d0 , then modify the key and `machine-id`. After that, go to Automation → Create Personal Automation → App → (choose **one** app) → (create a blank automation) → add Action 1: Text → enter this app’s name → add Action 2: Run Shortcut → (select the one you just imported) → turn off “Ask Before Running” / set to “Always Run.”<br>
If you want to monitor multiple apps on iOS, create separate Shortcuts for each app.<br>

# Android Guide<br>

[https://github.com/RewLight/foreground-monitor](https://github.com/RewLight/foreground-monitor)

# Linux Guide<br>

Download the Linux client from [Releases](https://github.com/QQ1816/SpyYourDesktop/releases/latest): `spy-your-desktop` (extensionless single-file binary, recommended) or `spy-your-desktop_1.0.0_amd64.deb`.<br>
Install the deb with `sudo apt install ./spy-your-desktop_1.0.0_amd64.deb`; for the single binary run `chmod +x spy-your-desktop`, then optionally `sudo install -m 0755 spy-your-desktop /usr/local/bin/spy-your-desktop`.<br>
Run `spy-your-desktop init` and enter the ingest URL (`http://SERVER_IP:3000/api/ingest`), a machine ID listed in the server's `group-map.json`, and the upload key from `name-keys.json`. Verify with `spy-your-desktop test`, then run `spy-your-desktop start` in the background. Use `spy-your-desktop stop` to stop at any time, `spy-your-desktop privacy on` to upload placeholders only, and `spy-your-desktop autostart install` to start at desktop login.<br>
The Linux client requires no server changes and only uploads the focused window title and application name; it never captures screenshots, keystrokes, clipboard, or file contents. On Wayland, the ability to read the focused window depends on the desktop environment; see [Linux/README.en.md](Linux/README.en.md) for the support table.<br>
**声明：Linux客户端只在Ubuntu 26.04的kde-wayland桌面环境测试通过** (Statement: the Linux client has only been tested on Ubuntu 26.04 with the KDE Wayland desktop). Other desktops, distributions, and architectures are untested.<br>

# Author’s Runtime Environment<br>

Server uses **BaoTa panel**, Node.js version **v12**; PC is **Windows 10**; **iOS 15.7** (with TrollStore installed); status reported via **Tailscale** (in practice, reporting directly by domain also works).<br>

# Disclaimer<br>

This project is for learning and communication only. Commercial use is prohibited.

