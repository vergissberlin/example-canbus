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

[Interaktiven Breadboard-Plan in Wokwi öffnen](https://wokwi.com/projects/478383260674919425)

Der Wokwi-Plan zeigt den Normalbetrieb mit beiden ESPs und CAN-Modulen auf
Breadboards sowie farbigen Steckbrücken. Die virtuellen ESP32-C3-DevKit-Boards
ersetzen dort die SuperMini-Darstellung: reale Pinpositionen und Lochreihen
weichen ab. Nach GPIO-Nummern und Modulbeschriftungen verbinden. Der Plan
ist eine Verdrahtungshilfe, keine elektrische CAN-Simulation. Im Normalbetrieb
darf keine CTX-GND-Testbrücke gesteckt sein.

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

### Verifizierter Hardware-Test vom 20. Oktober 2026

Getestet wurden zwei ESP32-C3 SuperMini mit je einem WCMCU-230, beide ESPs
mit eigener USB-Versorgung und ohne 5V-Brücke. Je Modul: ESP-3V3 an 3V3,
ESP-GND an GND, GPIO 5 an CTX und GPIO 4 an CRX. Zwischen den Modulen sind
CANH mit CANH, CANL mit CANL und GND mit GND verbunden. Beide vorhandenen
120-Ohm-Modulabschlüsse bleiben bestückt; keine zusätzlichen Abschlüsse.

| Prüfung | Ergebnis |
|---|---|
| Gezielte Einzelübertragung bei 500 kbit/s | In beiden Richtungen empfangen und mit ACK bestätigt; Fehlerzähler null |
| Gezielte Einzelübertragung bei 125 kbit/s | In beiden Richtungen empfangen und mit ACK bestätigt; Fehlerzähler null |
| Normalbetrieb bei 500 kbit/s | 23 Frames in Folge im Receiver, Zähler 13 bis 35 ohne Lücken, 23 ACK-Meldungen, keine beobachteten Busfehler |

Nach den Tests wurden die normalen Sender- und Receiver-Programme mit
500 kbit/s wieder aufgespielt. Die Beobachtung über etwa 23 Sekunden ist ein
Funktionstest und kein Nachweis langfristiger Störungsfreiheit. Die Prüfung
bei 125 kbit/s war ein Einzeltest in jede Richtung, kein Dauerlauf.

Während der Fehlersuche wurde eine fehlende Masseverbindung entdeckt. Frühere
fehlgeschlagene Versuche beweisen deshalb keinen Moduldefekt. Auch der manuelle
Dauertest mit CTX an GND ist hier kein zuverlässiger Defektnachweis: Trotz
fehlender dauerhafter Busdifferenz wurden kurze Impulse zurückgemeldet und
CAN-Frames erfolgreich übertragen. Der RX-Pegel kehrte bei GPIO-Abtastungen
zwischen etwa 100 und 300 Mikrosekunden auf High zurück, obwohl TX Low blieb;
die Ursache dieses Verhaltens wurde nicht abschließend bestimmt.

### Stromversorgung
- Verifizierter Aufbau: beide ESPs separat per USB versorgen, keine 5V-Brücke.
- Optional: nur Board #1 per USB, 5V und GND zu Board #2 bruecken.
- Beim Flashen die 5V-Bruecke loesen (Rueckspeisung vermeiden).
- Niemals 3V3 mit 3V3 verbinden. WCMCU-230 nie an 5 V.

## Debuggen im Browser (ohne Arduino IDE)

[CAN/LAB online öffnen](https://vergissberlin.github.io/example-canbus/debug/)


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

### Live-Signalweg

Oberhalb der WebSerial-Konsole zeigt die zusätzliche
[Kommunikations-SVG](docs/canbus-communication.svg) beide ESPs und CAN-Module.
Die Pinpositionen sind schematisch; der vollständige Breadboard-Plan bleibt
weiter oben verfügbar.

- **TX eingereiht:** GPIO 5 → CTX des jeweiligen Boards blitzt blau auf.
  Das bedeutet noch keinen bestätigten Empfang.
- **RX erkannt:** CANH/CANL und CRX → GPIO 4 des empfangenden Boards blitzen auf.
  Letzte CAN-ID, gegebenenfalls Zähler und Alter des RX-Logs stehen in der Grafik.
- **USB-Logdaten:** Die USB-Leitung des zugehörigen ESPs pulsiert bei seriellen
  Daten, auch bei Warte- und Fehlermeldungen. Das bestätigt allein keinen CAN-Empfang.
- **Fehler / Bus-Off:** Der betroffene ESP erhält eine rote Markierung.
  Sie verschwindet bei neuem RX-Empfang oder erneuter USB-Verbindung.

Die Anzeige basiert auf USB-Logs und ist keine elektrische Messung. ACKs und
elektrische Übertragungszeiten werden nicht simuliert. Versorgung und GND
bleiben statisch. Die 400-ms-Markierungen laufen unabhängig von Logfilter und
Konsolenpause; schnelle Ereignisse werden ohne Animationswarteschlange
zusammengefasst. Trennen entfernt aktive Markierungen des Boards. Bei
reduzierter Bewegung erscheint eine feste Farbmarkierung ohne Animation.
Auf kleinen Bildschirmen lässt sich die Grafik horizontal scrollen.
Kann die SVG nicht geladen werden, funktioniert WebSerial weiterhin.

### Tests

Parser- und Signaltests: `node --test debug/*.test.mjs`.

Für Browser-Integrationstests bei laufendem lokalen Server
http://localhost:8765/debug/communication.browser.test.html öffnen und
**Tests starten** anklicken. Die klar markierte Testseite verwendet virtuelle
USB-Ports in einem isolierten iframe und testet TX/RX, Pause/Filter,
Ereignisfolgen, Fehler, Trennen, mobile Darstellung, die Reduced-Motion-Regel
und den SVG-Ladefehler. Sie bestätigt keinen echten CAN-Empfang und verändert
keine Hardwareverbindungen der normalen Debug-Seite.

## Flashen mit PlatformIO

### Getrennter Hardware-Selbsttest

`pio run -c diagnostics.ini -e diagnostics -t upload --upload-port PORT` spielt
die spezielle Test-Firmware auf ein Board. Sie startet mit deaktiviertem
CAN-Controller und hält CTX auf dem rezessiven Pegel. Die Test-Firmware ersetzt
vorübergehend Sender bzw. Receiver; für den normalen Betrieb anschließend den
jeweiligen Sketch aus den folgenden Befehlen erneut flashen.

Serielle Befehle bei 115200 Baud, jeweils mit Zeilenumbruch: `quiet` deaktiviert
TWAI, `self500` und `self125` prüfen fünfmal den lokalen Selbstempfang mit
500 bzw. 125 kbit/s ohne ACK-Anforderung. Die Gegenstelle muss dabei `quiet`
sein. Solange CANH/CANL verbunden bleiben, kann ein Fehler am gemeinsamen Bus
auch diese lokalen Tests beeinflussen; ein Fehlschlag beweist keinen Chipdefekt.
`normal500`/`normal125` aktivieren normalen Empfang mit gleicher Bitrate auf
beiden Boards, `send` sendet einen einzelnen Testframe ohne Wiederholung,
`status` zeigt Fehlerzähler. Nur ein RX-Frame auf der Gegenstelle bestätigt
Netzwerkempfang; Selbstempfang wird ausdrücklich als `PROBE SELF` ausgegeben.

`internal` führt bei 500 kbit/s fünf Kontrollversuche mit Rückführung des
TX-Pads über die GPIO-Matrix aus. Damit werden Transceiver und GPIO4 umgangen;
Erfolg beweist keine Funktion des äußeren Signalwegs. `levels` schaltet GPIO5
bei gestopptem TWAI fünfmal kurz auf HIGH/LOW und liest GPIO4 mit Pull-up.
Der Test ist für den isolierten Breadboard-Aufbau mit getrennten CANH/CANL-
Verbindungen gedacht, nicht für einen angeschlossenen produktiven CAN-Bus.
Die Firmware kehrt nach diesen Tests in den stillen Zustand zurück.

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

- Die Diagnose-Firmware gibt `DIAG`-Zeilen mit Treiberzustand (`0` gestoppt,
  `1` aktiv, `2` Bus-Off, `3` Recovery), Fehlerzählern und dem abgetasteten
  RX-Pegel aus. Der Momentanpegel ist keine Spannungsmessung und beweist keine
  durchgehend ruhige Leitung. `TX_ACK=1` zeigt einen TX_SUCCESS-Alert des
  Controllers an; den Empfang in der Empfängeranwendung bestätigt erst deren RX-Log.
- Nach Bus-Off startet der Sender die Recovery und anschließend den Treiber neu.
- Unter Spannung direkt an jedem CAN-Modul zwischen `3V3` und `GND` ungefähr
  3,3 V prüfen, wenn der Sender Bus-Off meldet und der Receiver keine Frames sieht.
- Stromlos zwischen CANH und CANL messen: ca. **60 Ohm** (zwei Terminierungen parallel).
- `TX FEHLER`: keine Gegenstelle, CANH/CANL vertauscht oder Bitrate unterschiedlich.
- Bitrate steht in beiden Sketches auf 500 kbit/s.
- GPIO 2, 8, 9 sind Strapping-Pins, nicht fuer CAN nutzen.
