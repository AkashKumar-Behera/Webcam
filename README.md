# 🍿 Watch Party App

A lightweight, purely front-end 1-to-Many WebRTC Screen-Sharing application tailored for hosting movie watch parties. This application uses a custom TURN server for reliable mobile carrier connectivity and Firebase Realtime Database for signaling, participants management, and chat.

## ✨ Features
- **1-to-Many Mesh Topology**: Perfect for high-quality host-driven screen sharing.
- **Waitroom & Approvals (Google Meet Style)**: The Host has full control over who joins.
- **Mobile-First UX**: Responsive `100dvh` CSS with Safe-Area insets and native mobile Fullscreen playback API.
- **Sync & Chat**: Realtime chat system integrated via Firebase.
- **PWA Ready**: Works natively in the background on mobile devices.

---

## 🚀 Running Locally

There is no backend required (other than your TURN server). You can serve the static files directly.

1. Clone the repository.
2. Serve the directory using Python's built-in web server:
   ```bash
   python -m http.server 8080
   ```
3. Open `http://localhost:8080` in your browser.

---

## 🌐 Deploying to Netlify (CI/CD)

Since this app operates entirely on the frontend via HTML/JS and relies on external APIs (Firebase & external TURN), it can be deployed statically.

1. Push your code to a GitHub repository.
2. Sign up on **Netlify** and click "Add new site".
3. Select "Import an existing project" -> GitHub -> Select your Repo.
4. Leave the Build Command & Publish directory **empty**.
5. Click **Deploy**. Netlify will automatically update your site anytime you push code to GitHub `main`.

---

## 🛠️ Custom TURN Server Setup (VPS/Coturn)

WebRTC utilizes `STUN` & `TURN` servers to bypass carrier NATs (especially strict networks like Jio/Airtel on mobile). We highly recommend running your own Coturn server on a VPS (like Hostinger, DigitalOcean, or AWS).

### Step 1: Install Coturn on Ubuntu/Debian
```bash
sudo apt update
sudo apt install coturn -y
```

### Step 2: Configure Coturn
Backup the default configuration and create a new one:
```bash
sudo mv /etc/turnserver.conf /etc/turnserver.conf.backup
sudo nano /etc/turnserver.conf
```

Paste the following configuration (replace `<YOUR_VPS_IP>` and `<YOUR_SECRET_PASSWORD>`):
```ini
# TURN server name and auth
realm=watchparty-turn
server-name=watchparty-turn
listening-port=3478
tls-listening-port=5349

# Authentication details (Using Long-Term Credentials)
user=akash:<YOUR_SECRET_PASSWORD>
lt-cred-mech

# Bind to IP
listening-ip=<YOUR_VPS_IP>
external-ip=<YOUR_VPS_IP>

# Protocols (Force TCP relays to bypass mobile NAT firewalls)
no-multicast-peers
no-cli
no-loopback-peers
# IMPORTANT: Do NOT add "no-tcp-relay"! TCP Relay is REQUIRED for mobile networks like Jio/Airtel.
```

### Step 3: Enable the Daemon
Open `/etc/default/coturn` and uncomment or add the `TURNSERVER_ENABLED` flag:
```bash
sudo nano /etc/default/coturn
# Add this line:
TURNSERVER_ENABLED=1
```

### Step 4: Restart and Allow Firewall
Restart the Coturn service so the changes take effect:
```bash
sudo systemctl restart coturn
sudo systemctl enable coturn

# Ensure UDP/TCP rules are allowed
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 5349/udp
```

### Step 5: Link it to your App
Update `app.js` with your VPS details in the `servers` block:
```javascript
const servers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "turn:<YOUR_VPS_IP>:3478?transport=tcp", username: "akash", credential: "<YOUR_SECRET_PASSWORD>" },
    { urls: "turn:<YOUR_VPS_IP>:5349?transport=tcp", username: "akash", credential: "<YOUR_SECRET_PASSWORD>" }
  ],
  iceTransportPolicy: "all"
};
```