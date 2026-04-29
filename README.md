LC2 / DOGE2 Solo Miner
======================

A Windows solo merge-mining app for **LC2 (LitecoinII)** and **DOGE2 (Dogecoin2)**.
The installer includes the miner stack, wallet/daemon binaries, local dashboard, and one-click launcher.

**Dev fee: 1% (locked in app code)**

---

## Install

1. Run the latest `LC2-DOGE2-Solo-Miner-Setup-<version>.exe`
2. Finish the installer
3. Use the Desktop icon or Start Menu shortcut named `LC2 DOGE2 Solo Miner`

The one-click launcher starts the local daemons, the stratum proxy, and the dashboard automatically.

---

## First Run

On first launch, the app:

1. Starts the LC2 and DOGE2 daemon processes
2. Starts the local stratum proxy and dashboard
3. Creates `MINER-CONNECTION-INFO.txt` with the live stratum ports and dashboard URL

If default ports are already in use, the app automatically switches to the next available ports.

---

## How To Mine

1. Start the app using the Desktop icon or Start Menu shortcut
2. Open `MINER-CONNECTION-INFO.txt`
3. Point your miner to the LC2 or DOGE2 endpoint shown in that file
4. Open the dashboard URL shown in that file to monitor status

The most important user-facing files are:

- `MINER-CONNECTION-INFO.txt` for live ports and dashboard URL
- `TESTER-MINING-SETUP.txt` for miner examples and notes

---

## Notes

- The app runs locally on the same PC as the bundled daemons and dashboard
- Blockchain sync still takes normal time on first run
- Mining payout addresses can be changed in the dashboard
- The 1% dev fee is hard-baked and not user-configurable

---

## Support

If something is not working:

1. Check `MINER-CONNECTION-INFO.txt`
2. Open the dashboard shown there
3. Review the files in `data\`
4. Review `%LOCALAPPDATA%\LC2 DOGE2 Solo Miner\logs\watchdog.log`, `proxy-out.log`, and `proxy-err.log`
