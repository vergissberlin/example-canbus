# example-canbus

Minimale CAN-Bus-Demo mit zwei **ESP32-C3 SuperMini** und zwei **WCMCU-230** (SN65HVD230-Transceiver).
Der ESP32-C3 bringt den CAN-Controller (TWAI) mit, der WCMCU-230 setzt nur die Pegel auf den Bus um.

> Ein ESP8266 (z. B. D1 mini) hat **keinen** CAN-Controller und funktioniert so nicht.

## Hardware
- 2x ESP32-C3 SuperMini (Stiftleisten anloeten)
- 2x WCMCU-230 (3,3 V, 120-Ohm-Terminierung meist schon drauf)
- Breadboard, Jumperkabel

## Verdrahtung (auf beiden Seiten gleich)

| ESP32-C3 | WCMCU-230 |
|---|---|
| 3V3 | 3V3 |
| GND | GND |
| GPIO 5 | CTX |
| GPIO 4 | CRX |

Bus zwischen den Modulen: `CANH-CANH`, `CANL-CANL`, `GND-GND`.

### Breadboard-Anschlussplan

![Breadboard-Aufbau mit Sender, Receiver, CAN-Modulen und separater USB-Versorgung](docs/canbus-breadboard.svg)

[SVG herunterladen](docs/canbus-breadboard.svg) · [PNG-Vorschau](docs/canbus-breadboard.png)

Die Zeichnung zeigt beide ESPs mit separater USB-Versorgung. Bauteile und
Pinpositionen sind schematisch: beim Stecken nach den Beschriftungen am echten
Board gehen. Jeder CAN-Transceiver wird vom zugehörigen ESP mit 3,3 V versorgt.
Je Busende sind 120 Ohm zwischen CANH und CANL erforderlich; bereits vorhandene
Modul-Abschlusswiderstände mitzählen und nicht zusätzlich bestücken.

```
 C3 #1 -- WCMCU #1                 WCMCU #2 -- C3 #2
           CANH ------------------- CANH
           CANL ------------------- CANL
           GND  ------------------- GND
```

### Stromversorgung
- Optional: nur Board #1 per USB, 5V und GND zu Board #2 bruecken.
- Beim Flashen die 5V-Bruecke loesen (Rueckspeisung vermeiden).
- Niemals 3V3 mit 3V3 verbinden. WCMCU-230 nie an 5 V.

## Debuggen im Browser (ohne Arduino IDE)

Die lokale [CAN/LAB-Konsole](debug/index.html) liest die USB-Ausgabe der bereits
geflashten Sketches. Sie kann beide Boards gleichzeitig öffnen, RX-Zähler und
Zählersprünge anzeigen sowie Logs filtern, pausieren und als Text exportieren.
Die Firmware muss dafür nicht geändert werden.

1. Im Repository `./debug/serve.command` starten (auf macOS auch per Doppelklick).
2. In **Microsoft Edge oder Google Chrome** auf dem Mac
   **http://localhost:8765/debug/** öffnen. Der Browser muss Web Serial unterstützen.
3. Beide ESPs per USB anschließen; bei separater USB-Versorgung keine 5V-Brücke
   zwischen den Boards stecken. Andere serielle Monitore schließen.
4. Pro Board **USB verbinden** anklicken und den zugehörigen Port freigeben.
   Bei identischen Geräten zuerst nur den Receiver anschließen und verbinden,
   danach den Sender anschließen und verbinden.
5. Falls keine Ausgabe erscheint, am jeweiligen Board kurz **RESET ohne BOOT**
   drücken. Steigende `RX ID 0x123`-Zähler bestätigen CAN-Kommunikation;
   `TX … ok` bestätigt lediglich das Einreihen beim Sender.

Die Aufzeichnung bleibt im Browser; maximal 2000 Logzeilen werden gespeichert.
„Anzeige pausieren“ stoppt nur die Darstellung; Aufzeichnung und Messwerte laufen
weiter. „Leeren“ entfernt die Logzeilen, die Messwerte bleiben erhalten. Ein
Seiten-Reload schließt die Verbindungen und setzt Logs und Messwerte zurück.
Zählersprünge können auch durch fehlende USB-Logzeilen entstehen und beweisen
keinen CAN-Paketverlust. Server mit `Ctrl+C` beenden.

Parser-Tests: `node --test debug/protocol.test.mjs`.

## Flashen mit PlatformIO

```sh
# Sender
pio run -e sender -t upload

# Receiver
pio run -c receiver.ini -e receiver -t upload
```

## Nutzung (Arduino IDE)
1. Board: *ESP32C3 Dev Module*, **USB CDC On Boot: Enabled**.
2. `sender/sender.ino` auf Board #1, `receiver/receiver.ino` auf Board #2 flashen.
3. Serial Monitor (115200 Baud) oeffnen.

## Troubleshooting
- Stromlos zwischen CANH und CANL messen: ca. **60 Ohm** (zwei Terminierungen parallel).
- `TX FEHLER`: keine Gegenstelle, CANH/CANL vertauscht oder Bitrate unterschiedlich.
- Bitrate steht in beiden Sketches auf 500 kbit/s.
- GPIO 2, 8, 9 sind Strapping-Pins, nicht fuer CAN nutzen.

## Lizenz
MIT
