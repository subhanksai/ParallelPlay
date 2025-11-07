/*
README:
- Install dependencies: npm install
- Start server: node control.js
- The server listens on port 3000 by default.
- Expects VLC web interfaces at http://10.10.10.2:8080 and http://10.10.10.1:8080
*/

// Import required dependencies
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const bodyParser = require('body-parser');

// Initialize Express application
const app = express();
const PORT = process.env.PORT || 3000;

const LOG_FILE = "control_log.txt";
const ERROR_LOG_FILE = "control_errors.log";
const PATHS_FILE = "paths.txt";
const VLC_URL_MASTER = "http://192.168.127.177:8080/requests/status.json";
const VLC_URL_SLAVE = "http://192.168.127.141:8080/requests/status.json";
const PASSWORD = process.env.VLC_PASSWORD;
if (!PASSWORD) {
  console.error('ERROR: VLC_PASSWORD environment variable is required');
  process.exit(1);
}

// Configure middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Default route to serve index.html
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

// Create write streams for logging
const actionLogStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const errorLogStream = fs.createWriteStream(ERROR_LOG_FILE, { flags: 'a' });

// Logging middleware with streaming for better performance
function logAction(message) {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  const logMessage = `[${timestamp}] ${message}\n`;
  actionLogStream.write(logMessage);
}

// Error logging with streaming for better performance
function logError(message) {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  const logMessage = `[${timestamp}] ${message}\n`;
  errorLogStream.write(logMessage);
}

// Helper: Send command to VLC
async function sendCommand(url, password) {
  // Cache for authorization header to avoid repeated Buffer operations
  const authHeader = "Basic " + Buffer.from(":" + password).toString("base64");
  
  try {
    // Reuse headers object for better performance
    const headers = {
      Authorization: authHeader,
      'Connection': 'keep-alive', // Reuse connections
    };

    const res = await fetch(url, { headers });
    const text = await res.text();
    
    // Memory management: explicitly clear response
    res.body.destroy();
    return text;
  } catch (err) {
    logError(`sendCommand error: ${err}`);
    return null;
  }
}

// Helper: Get VLC status
async function getVLCStatus(url, password) {
  try {
    const res = await fetch(url, {
      headers: {
        Authorization:
          "Basic " + Buffer.from(":" + password).toString("base64"),
      },
    });
    return await res.json();
  } catch (err) {
    logError(`getVLCStatus error: ${err}`);
    return null;
  }
}

// Helper: Check fullscreen
async function isFullscreen(url, password) {
  const data = await getVLCStatus(url, password);
  return data && typeof data.fullscreen !== "undefined" ? data.fullscreen : -1;
}

// Helper: Read paths
function readPaths() {
  logAction(`Reading paths from ${PATHS_FILE}`);
  if (fs.existsSync(PATHS_FILE)) {
    const content = fs.readFileSync(PATHS_FILE, "utf-8");
    logAction(`File content: ${content}`);
    const lines = content.split(/\r?\n/);
    let masterFile = "",
      slaveFile = "";
    lines.forEach((line) => {
      if (line.startsWith("MASTER_VIDEO_PATH="))
        masterFile = line.replace("MASTER_VIDEO_PATH=", "");
      if (line.startsWith("SLAVE_VIDEO_PATH="))
        slaveFile = line.replace("SLAVE_VIDEO_PATH=", "");
    });
    logAction(
      `Read paths: masterFile="${masterFile}", slaveFile="${slaveFile}"`
    );
    return { masterFile, slaveFile };
  }
  logAction(`Paths file ${PATHS_FILE} does not exist`);
  return { masterFile: "", slaveFile: "" };
}

// Helper: Save paths
function savePaths(masterFile, slaveFile) {
  fs.writeFileSync(
    PATHS_FILE,
    `MASTER_VIDEO_PATH=${masterFile}\nSLAVE_VIDEO_PATH=${slaveFile}`
  );
}

// Helper: Set fullscreen (always enter fullscreen)
async function setFullscreen(url, password, label) {
  logAction(`${label} setting fullscreen`);
  await sendCommand(
    `${url.replace("/requests/status.json", "")}?command=fullscreen`,
    password
  );
  return `${label} set to fullscreen.`;
}

// Helper: Enter fullscreen only if not already in fullscreen
async function enterFullscreenIfNeeded(url, password, label) {
  const status = await isFullscreen(url, password);
  logAction(`${label} fullscreen status: ${status}`);

  if (status === 1) {
    // Already in fullscreen, do nothing
    return `${label} already in fullscreen.`;
  } else {
    // Not in fullscreen or status unknown, enter fullscreen
    await sendCommand(
      `${url.replace("/requests/status.json", "")}?command=fullscreen`,
      password
    );
    return `${label} entered fullscreen.`;
  }
}

// Helper: Force load correct files from paths.txt (optimized)
async function forceLoadCorrectFiles(masterFile, slaveFile) {
  logAction(
    `Checking if correct files are loaded: Master="${masterFile}", Slave="${slaveFile}"`
  );

  // Quick check - only load if VLC is not playing or if we can't get status
  const statusMaster = await getVLCStatus(VLC_URL_MASTER, PASSWORD);
  const statusSlave = await getVLCStatus(VLC_URL_SLAVE, PASSWORD);

  // Only force load if VLC is not playing or status is unavailable
  const shouldLoadMaster =
    !statusMaster ||
    statusMaster.state === "stopped" ||
    statusMaster.state === "paused";
  const shouldLoadSlave =
    !statusSlave ||
    statusSlave.state === "stopped" ||
    statusSlave.state === "paused";

  if (shouldLoadMaster) {
    logAction(`Loading master file: ${masterFile}`);
    await sendCommand(
      `${VLC_URL_MASTER.replace(
        "/status.json",
        ""
      )}?command=in_play&input=${encodeURIComponent(masterFile)}`,
      PASSWORD
    );
  }

  if (shouldLoadSlave) {
    logAction(`Loading slave file: ${slaveFile}`);
    await sendCommand(
      `${VLC_URL_SLAVE.replace(
        "/status.json",
        ""
      )}?command=in_play&input=${encodeURIComponent(slaveFile)}`,
      PASSWORD
    );
  }

  // Only wait if we actually loaded files
  if (shouldLoadMaster || shouldLoadSlave) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    logAction("Files loaded successfully");
  } else {
    logAction("Files already loaded, skipping load operation");
  }
}

// Main endpoint
app.post("/control", async (req, res) => {
  logAction("Accessed /control");
  logAction("GET Data: " + JSON.stringify(req.query));
  logAction("POST Data: " + JSON.stringify(req.body));

  let { command, masterFile, slaveFile, seekValue } = req.body;
  if (!slaveFile) slaveFile = masterFile; // fallback for legacy

  // Always read latest paths from file for all commands except savePaths
  if (command !== "savePaths") {
    const paths = readPaths();
    masterFile = masterFile || paths.masterFile;
    slaveFile = slaveFile || paths.slaveFile;

    if (!masterFile || !slaveFile) {
      return res.json({
        error: "No file paths found. Please save file paths first.",
      });
    }
  }

  let responseMessage = "";

  switch (command) {
    case "play": {
      const { masterFile, slaveFile } = readPaths();
      if (!masterFile || !slaveFile) {
        return res.json({ error: "File paths not found. Save them first." });
      }

      // Check current playback state
      const [statusMaster, statusSlave] = await Promise.all([
        getVLCStatus(VLC_URL_MASTER, PASSWORD),
        getVLCStatus(VLC_URL_SLAVE, PASSWORD),
      ]);

      const masterPaused = statusMaster?.state === "paused";
      const slavePaused = statusSlave?.state === "paused";

      const resumingFromPause = masterPaused || slavePaused;

      if (!resumingFromPause) {
        logAction("Enqueuing media files on both players...");
        await sendCommand(
          `${VLC_URL_MASTER}?command=in_enqueue&input=${encodeURIComponent(masterFile)}`,
          PASSWORD
        );
        await sendCommand(
          `${VLC_URL_SLAVE}?command=in_enqueue&input=${encodeURIComponent(slaveFile)}`,
          PASSWORD
        );

        logAction("Activating enqueued files (pl_next)...");
        await sendCommand(`${VLC_URL_MASTER}?command=pl_next`, PASSWORD);
        await sendCommand(`${VLC_URL_SLAVE}?command=pl_next`, PASSWORD);

        // Reset playback rate and seek to 0 only on fresh start
        await sendCommand(`${VLC_URL_MASTER}?command=rate&val=1.0`, PASSWORD);
        await sendCommand(`${VLC_URL_SLAVE}?command=rate&val=1.0`, PASSWORD);
        await sendCommand(`${VLC_URL_MASTER}?command=seek&val=0`, PASSWORD);
        await sendCommand(`${VLC_URL_SLAVE}?command=seek&val=0`, PASSWORD);

        logAction("Waiting 1 second before starting playback...");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Start/resume playback
      await sendCommand(`${VLC_URL_MASTER}?command=pl_play`, PASSWORD);
      await sendCommand(`${VLC_URL_SLAVE}?command=pl_play`, PASSWORD);

      // Wait a bit for playback to initialize before checking fullscreen
      await new Promise((resolve) => setTimeout(resolve, 300));

      const [updatedStatusMaster, updatedStatusSlave] = await Promise.all([
        getVLCStatus(VLC_URL_MASTER, PASSWORD),
        getVLCStatus(VLC_URL_SLAVE, PASSWORD),
      ]);

      const fullscreenMaster = updatedStatusMaster.fullscreen === true;
      const fullscreenSlave = updatedStatusSlave.fullscreen === true;

      if (!fullscreenMaster) {
        await sendCommand(`${VLC_URL_MASTER}?command=fullscreen`, PASSWORD);
      }
      if (!fullscreenSlave) {
        await sendCommand(`${VLC_URL_SLAVE}?command=fullscreen`, PASSWORD);
      }

      responseMessage = resumingFromPause
        ? `Playback resumed from paused position. Fullscreen: Master - ${fullscreenMaster ? "already" : "now"} ON, Slave - ${fullscreenSlave ? "already" : "now"} ON.`
        : `Playback started in sync after 1-second buffer. Rate set to 1.0x. Fullscreen: Master - ${fullscreenMaster ? "already" : "now"} ON, Slave - ${fullscreenSlave ? "already" : "now"} ON.`;
      break;
    }

    // case "play": {
    //   const { masterFile, slaveFile } = readPaths();
    //   if (!masterFile || !slaveFile) {
    //     return res.json({ error: "File paths not found. Save them first." });
    //   }

    //   logAction("Enqueuing media files on both players...");
    //   await sendCommand(
    //     `${VLC_URL_MASTER}?command=in_enqueue&input=${encodeURIComponent(
    //       masterFile
    //     )}`,
    //     PASSWORD
    //   );
    //   await sendCommand(
    //     `${VLC_URL_SLAVE}?command=in_enqueue&input=${encodeURIComponent(
    //       slaveFile
    //     )}`,
    //     PASSWORD
    //   );

    //   logAction("Activating enqueued files (pl_next)...");
    //   await sendCommand(`${VLC_URL_MASTER}?command=pl_next`, PASSWORD);
    //   await sendCommand(`${VLC_URL_SLAVE}?command=pl_next`, PASSWORD);

    //   // Reset playback rate to normal
    //   await sendCommand(`${VLC_URL_MASTER}?command=rate&val=1.0`, PASSWORD);
    //   await sendCommand(`${VLC_URL_SLAVE}?command=rate&val=1.0`, PASSWORD);

    //   // Optional: Seek to 0 if needed
    //   await sendCommand(`${VLC_URL_MASTER}?command=seek&val=0`, PASSWORD);
    //   await sendCommand(`${VLC_URL_SLAVE}?command=seek&val=0`, PASSWORD);

    //   logAction("Waiting 1 second before starting playback...");
    //   await new Promise((resolve) => setTimeout(resolve, 1000)); // Let VLC buffer and stabilize

    //   // Start playback
    //   await sendCommand(`${VLC_URL_MASTER}?command=pl_play`, PASSWORD);
    //   await sendCommand(`${VLC_URL_SLAVE}?command=pl_play`, PASSWORD);

    //   // Fullscreen handling
    //   const [statusMaster, statusSlave] = await Promise.all([
    //     getVLCStatus(VLC_URL_MASTER, PASSWORD),
    //     getVLCStatus(VLC_URL_SLAVE, PASSWORD),
    //   ]);
    //   if (!statusMaster.fullscreen) {
    //     await sendCommand(`${VLC_URL_MASTER}?command=fullscreen`, PASSWORD);
    //   }
    //   if (!statusSlave.fullscreen) {
    //     await sendCommand(`${VLC_URL_SLAVE}?command=fullscreen`, PASSWORD);
    //   }

    //   responseMessage =
    //     "Playback started in sync after 1-second buffer. Rate set to 1.0x.";
    //   break;
    // }

    ///////////////////////////////////////
    // case "play": {
    //   const { masterFile, slaveFile } = readPaths();
    //   if (!masterFile || !slaveFile) {
    //     return res.json({ error: "File paths not found. Save them first." });
    //   }

    //   // Check current playback state
    //   const [statusMaster, statusSlave] = await Promise.all([
    //     getVLCStatus(VLC_URL_MASTER, PASSWORD),
    //     getVLCStatus(VLC_URL_SLAVE, PASSWORD),
    //   ]);

    //   const masterPaused = statusMaster?.state === "paused";
    //   const slavePaused = statusSlave?.state === "paused";

    //   const resumingFromPause = masterPaused || slavePaused;

    //   if (!resumingFromPause) {
    //     logAction("Enqueuing media files on both players...");
    //     await sendCommand(
    //       `${VLC_URL_MASTER}?command=in_enqueue&input=${encodeURIComponent(masterFile)}`,
    //       PASSWORD
    //     );
    //     await sendCommand(
    //       `${VLC_URL_SLAVE}?command=in_enqueue&input=${encodeURIComponent(slaveFile)}`,
    //       PASSWORD
    //     );

    //     logAction("Activating enqueued files (pl_next)...");
    //     await sendCommand(`${VLC_URL_MASTER}?command=pl_next`, PASSWORD);
    //     await sendCommand(`${VLC_URL_SLAVE}?command=pl_next`, PASSWORD);

    //     // Reset playback rate and seek to 0 only on fresh start
    //     await sendCommand(`${VLC_URL_MASTER}?command=rate&val=1.0`, PASSWORD);
    //     await sendCommand(`${VLC_URL_SLAVE}?command=rate&val=1.0`, PASSWORD);
    //     await sendCommand(`${VLC_URL_MASTER}?command=seek&val=0`, PASSWORD);
    //     await sendCommand(`${VLC_URL_SLAVE}?command=seek&val=0`, PASSWORD);

    //     logAction("Waiting 1 second before starting playback...");
    //     await new Promise((resolve) => setTimeout(resolve, 1000));
    //   }

    //   // Start/resume playback
    //   await sendCommand(`${VLC_URL_MASTER}?command=pl_play`, PASSWORD);
    //   await sendCommand(`${VLC_URL_SLAVE}?command=pl_play`, PASSWORD);

    //   // Fullscreen handling
    //   if (!statusMaster.fullscreen) {
    //     await sendCommand(`${VLC_URL_MASTER}?command=fullscreen`, PASSWORD);
    //   }
    //   if (!statusSlave.fullscreen) {
    //     await sendCommand(`${VLC_URL_SLAVE}?command=fullscreen`, PASSWORD);
    //   }

    //   responseMessage = resumingFromPause
    //     ? "Playback resumed from paused position."
    //     : "Playback started in sync after 1-second buffer. Rate set to 1.0x.";
    //   break;
    // }
    /////////////////////////////
    case "pause": {
      const statusMaster = await getVLCStatus(VLC_URL_MASTER, PASSWORD);
      const statusSlave = await getVLCStatus(VLC_URL_SLAVE, PASSWORD);
      if (!statusMaster || !statusSlave)
        return res.json({ error: "Could not retrieve VLC status." });
      const isMasterPlaying = statusMaster.state === "playing";
      const isSlavePlaying = statusSlave.state === "playing";
      const masterTime = statusMaster.time || 0;
      const slaveTime = statusSlave.time || 0;
      const maxTime = Math.max(masterTime, slaveTime);
      // Seek both to the latest time
      await sendCommand(
        `${VLC_URL_MASTER}?command=seek&val=${maxTime}`,
        PASSWORD
      );
      await sendCommand(
        `${VLC_URL_SLAVE}?command=seek&val=${maxTime}`,
        PASSWORD
      );
      // Only pause those that are currently playing
      if (isMasterPlaying) {
        await sendCommand(`${VLC_URL_MASTER}?command=pl_pause`, PASSWORD);
      }
      if (isSlavePlaying) {
        await sendCommand(`${VLC_URL_SLAVE}?command=pl_pause`, PASSWORD);
      }
      responseMessage = `Both players synced to ${maxTime} sec and paused (no toggling).`;
      break;
    }
    case "stop": {
      await sendCommand(`${VLC_URL_MASTER}?command=pl_stop`, PASSWORD);
      await sendCommand(`${VLC_URL_SLAVE}?command=pl_stop`, PASSWORD);
      responseMessage = "Both players stopped.";
      break;
    }
    case "seek": {
      if (seekValue && !isNaN(seekValue)) {
        await sendCommand(
          `${VLC_URL_MASTER}?command=seek&val=${seekValue}`,
          PASSWORD
        );
        await sendCommand(
          `${VLC_URL_SLAVE}?command=seek&val=${seekValue}`,
          PASSWORD
        );
        responseMessage = "Seek command sent.";
      } else {
        return res.json({ error: "Invalid or missing seek value." });
      }
      break;
    }
    case "skip_forward": {
      const statusMaster = await getVLCStatus(VLC_URL_MASTER, PASSWORD);
      const statusSlave = await getVLCStatus(VLC_URL_SLAVE, PASSWORD);
      if (!statusMaster || !statusSlave)
        return res.json({ error: "Could not retrieve VLC status." });
      const masterTime = (statusMaster.time || 0) + 10;
      const slaveTime = (statusSlave.time || 0) + 10;
      await sendCommand(
        `${VLC_URL_MASTER}?command=seek&val=${masterTime}`,
        PASSWORD
      );
      await sendCommand(
        `${VLC_URL_SLAVE}?command=seek&val=${slaveTime}`,
        PASSWORD
      );
      responseMessage = "Skipped forward 10 seconds.";
      break;
    }
    case "skip_backward": {
      const statusMaster = await getVLCStatus(VLC_URL_MASTER, PASSWORD);
      const statusSlave = await getVLCStatus(VLC_URL_SLAVE, PASSWORD);
      if (!statusMaster || !statusSlave)
        return res.json({ error: "Could not retrieve VLC status." });
      const masterTime = Math.max(0, (statusMaster.time || 0) - 10);
      const slaveTime = Math.max(0, (statusSlave.time || 0) - 10);
      await sendCommand(
        `${VLC_URL_MASTER}?command=seek&val=${masterTime}`,
        PASSWORD
      );
      await sendCommand(
        `${VLC_URL_SLAVE}?command=seek&val=${slaveTime}`,
        PASSWORD
      );
      responseMessage = "Skipped backward 10 seconds.";
      break;
    }
    case "wakeUp": {
      if (masterFile && slaveFile) {
        // Load files using in_enqueue + pl_next instead of in_play to avoid auto-start
        await sendCommand(
          `${VLC_URL_MASTER}?command=in_enqueue&input=${encodeURIComponent(
            masterFile
          )}`,
          PASSWORD
        );
        await sendCommand(
          `${VLC_URL_SLAVE}?command=in_enqueue&input=${encodeURIComponent(
            slaveFile
          )}`,
          PASSWORD
        );

        await new Promise((resolve) => setTimeout(resolve, 300)); // Give time to enqueue

        // Move to enqueued track (won't auto-play)
        await sendCommand(`${VLC_URL_MASTER}?command=pl_next`, PASSWORD);
        await sendCommand(`${VLC_URL_SLAVE}?command=pl_next`, PASSWORD);

        // Set rate to 1.0x
        await sendCommand(`${VLC_URL_MASTER}?command=rate&val=1.0`, PASSWORD);
        await sendCommand(`${VLC_URL_SLAVE}?command=rate&val=1.0`, PASSWORD);

        // Seek to beginning
        await sendCommand(`${VLC_URL_MASTER}?command=seek&val=0`, PASSWORD);
        await sendCommand(`${VLC_URL_SLAVE}?command=seek&val=0`, PASSWORD);

        // Let everything settle
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Start playback
        await sendCommand(`${VLC_URL_MASTER}?command=pl_play`, PASSWORD);
        await sendCommand(`${VLC_URL_SLAVE}?command=pl_play`, PASSWORD);

        // Set fullscreen if not already
        const [statusMaster, statusSlave] = await Promise.all([
          getVLCStatus(VLC_URL_MASTER, PASSWORD),
          getVLCStatus(VLC_URL_SLAVE, PASSWORD),
        ]);
        if (!statusMaster.fullscreen) {
          await sendCommand(`${VLC_URL_MASTER}?command=fullscreen`, PASSWORD);
        }
        if (!statusSlave.fullscreen) {
          await sendCommand(`${VLC_URL_SLAVE}?command=fullscreen`, PASSWORD);
        }

        responseMessage =
          "Wake-up completed: media loaded, rate set, playback started smoothly.";
      } else {
        return res.json({ error: "File paths not found. Save them first." });
      }
      break;
    }

    case "fullscreen": {
      // Refresh status to get fullscreen flags
      await new Promise((resolve) => setTimeout(resolve, 300));
      statusMaster = await getVLCStatus(VLC_URL_MASTER, PASSWORD);
      statusSlave = await getVLCStatus(VLC_URL_SLAVE, PASSWORD);

      const fullscreenMaster = statusMaster.fullscreen === true;
      const fullscreenSlave = statusSlave.fullscreen === true;

      if (!fullscreenMaster) {
        await sendCommand(`${VLC_URL_MASTER}?command=fullscreen`, PASSWORD);
      }
      if (!fullscreenSlave) {
        await sendCommand(`${VLC_URL_SLAVE}?command=fullscreen`, PASSWORD);
      }

      responseMessage = `Both players playing. Fullscreen: Master - ${fullscreenMaster ? "already" : "now"
        } ON, Slave - ${fullscreenSlave ? "already" : "now"} ON.`;
      break;
    }

    case "sync": {
      // Always read the latest paths from file
      const { masterFile, slaveFile } = readPaths();
      if (!masterFile || !slaveFile) {
        return res.json({ error: "File paths not found. Save them first." });
      }

      let statusMaster, statusSlave;
      const retries = 3;
      let masterOk = false,
        slaveOk = false;

      // Try fetching status with retries
      for (let i = 0; i < retries; i++) {
        statusMaster = await getVLCStatus(VLC_URL_MASTER, PASSWORD);
        statusSlave = await getVLCStatus(VLC_URL_SLAVE, PASSWORD);
        masterOk = statusMaster && typeof statusMaster.time !== "undefined";
        slaveOk = statusSlave && typeof statusSlave.time !== "undefined";
        if (masterOk && slaveOk) break;
        await new Promise((r) => setTimeout(r, 200));
      }

      if (!masterOk && !slaveOk) {
        return res.json({ error: "Both VLC systems are unreachable." });
      } else if (!masterOk) {
        // Attempt to wake up master
        await sendCommand(
          `${VLC_URL_MASTER.replace(
            "/status.json",
            ""
          )}?command=in_play&input=${encodeURIComponent(masterFile)}`,
          PASSWORD
        );
        await new Promise((r) => setTimeout(r, 350));
        statusMaster = await getVLCStatus(VLC_URL_MASTER, PASSWORD);
        if (!statusMaster || typeof statusMaster.time === "undefined") {
          return res.json({
            error: "Master VLC is unreachable or failed to reload.",
          });
        }
      } else if (!slaveOk) {
        // Attempt to wake up slave
        await sendCommand(
          `${VLC_URL_SLAVE.replace(
            "/status.json",
            ""
          )}?command=in_play&input=${encodeURIComponent(slaveFile)}`,
          PASSWORD
        );
        await new Promise((r) => setTimeout(r, 350));
        statusSlave = await getVLCStatus(VLC_URL_SLAVE, PASSWORD);
        if (!statusSlave || typeof statusSlave.time === "undefined") {
          return res.json({
            error: "Slave VLC is unreachable or failed to reload.",
          });
        }
      }

      // Reload file if not in 'playing' state
      let didWakeMaster = false,
        didWakeSlave = false;
      if (statusMaster.state !== "playing") {
        await sendCommand(
          `${VLC_URL_MASTER.replace(
            "/status.json",
            ""
          )}?command=in_play&input=${encodeURIComponent(masterFile)}`,
          PASSWORD
        );
        await new Promise((r) => setTimeout(r, 350));
        statusMaster = await getVLCStatus(VLC_URL_MASTER, PASSWORD);
        didWakeMaster = true;
      }
      if (statusSlave.state !== "playing") {
        await sendCommand(
          `${VLC_URL_SLAVE.replace(
            "/status.json",
            ""
          )}?command=in_play&input=${encodeURIComponent(slaveFile)}`,
          PASSWORD
        );
        await new Promise((r) => setTimeout(r, 350));
        statusSlave = await getVLCStatus(VLC_URL_SLAVE, PASSWORD);
        didWakeSlave = true;
      }
      //
      // Compare timestamps and sync only the one behind
      const masterTime = parseFloat(statusMaster.time);
      const slaveTime = parseFloat(statusSlave.time);
      const threshold = 0.5;

      // Only sync if there's a significant difference
      if (Math.abs(masterTime - slaveTime) > threshold) {
        if (masterTime < slaveTime) {
          // Master is behind, sync it to slave's time
          await sendCommand(
            `${VLC_URL_MASTER}?command=seek&val=${slaveTime + 1} `,
            PASSWORD
          );
          logAction(
            `Synced master from ${masterTime.toFixed(
              1
            )}s to ${slaveTime.toFixed(1)}s`
          );
        } else if (slaveTime < masterTime) {
          // Slave is behind, sync it to master's time
          await sendCommand(
            `${VLC_URL_SLAVE}?command=seek&val=${masterTime + 1}`,
            PASSWORD
          );
          logAction(
            `Synced slave from ${slaveTime.toFixed(1)}s to ${masterTime.toFixed(
              1
            )}s`
          );
        }

        // Ensure playback continues on both
        await sendCommand(`${VLC_URL_MASTER}?command=pl_play`, PASSWORD);
        await sendCommand(`${VLC_URL_SLAVE}?command=pl_play`, PASSWORD);

        const finalTime = Math.max(masterTime, slaveTime) + 1;
        const message = `Sync complete. Both players are now playing at ~${finalTime.toFixed(
          1
        )} sec.`;
        return res.json({ message });
      }
    }

    case "setSpeed": {
      const { speed } = req.body;
      if (speed && !isNaN(speed) && speed > 0) {
        logAction(`Setting speed to ${speed}x on both systems`);

        // Set speed on both master and slave
        await sendCommand(
          `${VLC_URL_MASTER}?command=rate&val=${speed}`,
          PASSWORD
        );
        await sendCommand(
          `${VLC_URL_SLAVE}?command=rate&val=${speed}`,
          PASSWORD
        );

        // Wait for speed changes to take effect
        await new Promise((resolve) => setTimeout(resolve, 200));

        responseMessage = `Speed set to ${speed}x on both players.`;
      } else {
        return res.json({
          error: "Invalid speed value. Must be a positive number.",
        });
      }
      break;
    }

    case "resetSpeed": {
      logAction("Resetting speed to 1.0x on both systems");
      await sendCommand(`${VLC_URL_MASTER}?command=rate&val=1.0`, PASSWORD);
      await sendCommand(`${VLC_URL_SLAVE}?command=rate&val=1.0`, PASSWORD);
      await new Promise((resolve) => setTimeout(resolve, 200));
      responseMessage = "Speed reset to 1.0x on both players.";
      break;
    }
    case "savePaths": {
      logAction(
        `savePaths command received. masterFile: "${masterFile}", slaveFile: "${slaveFile}"`
      );
      if (masterFile && slaveFile) {
        try {
          logAction(`About to save paths to ${PATHS_FILE}`);
          savePaths(masterFile, slaveFile);
          logAction(`Paths saved successfully to ${PATHS_FILE}`);

          // Verify the file was written correctly
          const savedPaths = readPaths();
          logAction(
            `Verification - read back from file: masterFile="${savedPaths.masterFile}", slaveFile="${savedPaths.slaveFile}"`
          );

          return res.json({ message: "Paths saved successfully." });
        } catch (error) {
          logError(`Error saving paths: ${error.message}`);
          return res.json({ error: `Failed to save paths: ${error.message}` });
        }
      } else {
        logAction(
          `savePaths failed: Missing file paths. masterFile: "${masterFile}", slaveFile: "${slaveFile}"`
        );
        return res.json({ error: "Missing file paths." });
      }
    }
    default:
      return res.json({ error: "Invalid command." });
  }
  res.json({ message: responseMessage });
});

app.listen(PORT, () => {
  console.log(`Control server running on port ${PORT}`);
});
