/**
 * @license
 * Code City Client
 *
 * Copyright 2017 Google Inc.
 * https://codecity.world/
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview Code City's client.
 * @author fraser@google.com (Neil Fraser)
 */
'use strict';

var CCC = {};

/**
 * Smallest interval in milliseconds between pings.
 * @constant
 */
CCC.MIN_PING_INTERVAL = 1000;

/**
 * Largest interval in milliseconds between pings.
 * @constant
 */
CCC.MAX_PING_INTERVAL = 16000;

/**
 * Maximum number of commands saved in history.
 * @constant
 */
CCC.MAX_HISTORY_SIZE = 1000;

/**
 * Location to send pings to.
 * @constant
 */
CCC.PING_URL = '/connect?ping';

// Properties below this point are not configurable.

/**
 * All the commands the user has sent.
 */
CCC.commandHistory = [];

/**
 * When browsing the command history, save the current command here.
 */
CCC.commandTemp = '';

/**
 * Where in the command history are we browsing?
 */
CCC.commandHistoryPointer = -1;

/**
 * When was the last time we saw the user?
 * @type {number}
 */
CCC.lastActiveTime = Date.now();

/**
 * Number of lines we think the user has not seen.
 */
CCC.unreadLines = 0;

/**
 * The index number of the first command on the commandOutput queue.
 */
CCC.commandIndex = 0;

/**
 * Queue of commands being sent, awaiting acks from server.
 */
CCC.commandOutput = [];

/**
 * Bit to switch off local echo when typing passwords.
 */
CCC.localEcho = true;

/**
 * The index number of the most recent message received from the server.
 */
CCC.messageIndex = 0;

/**
 * Number of calls to countdown required before launching.
 */
CCC.countdownValue = 2;

/**
 * XMLHttpRequest currently in flight, or null.
 * @type {XMLHttpRequest}
 */
CCC.xhrObject = null;

/**
 * Current length of time between pings.
 */
CCC.pingInterval = CCC.MIN_PING_INTERVAL;

/**
 * Process ID of next ping to the server.
 */
CCC.nextPingPid = -1;

/**
 * Flag for only acknowledging new messages after a new message has arrived.
 * Saves bandwidth.
 */
CCC.ackMsgNextPing = true;

/**
 * Unique queue ID.  Identifies this client to the connectServer across
 * polling connections.  Set by the server at startup.
 * @private
 */
CCC.queueId_ = SESSION_ID;

/**
 * After every iframe has reported ready, call the initialization.
 */
CCC.countdown = function() {
  CCC.countdownValue--;
  if (!CCC.countdownValue) {
    CCC.init();
  }
};

/**
 * Initialization code called on startup.
 */
CCC.init = function() {
  CCC.worldFrame = document.getElementById('worldFrame');
  CCC.logFrame = document.getElementById('logFrame');
  CCC.displayCell = document.getElementById('displayCell');
  CCC.commandTextarea = document.getElementById('commandTextarea');

  window.addEventListener('resize', CCC.resize, false);
  CCC.resize();

  CCC.commandTextarea.addEventListener('keydown', CCC.keydown, false);
  CCC.commandTextarea.value = '';
  CCC.commandTextarea.focus();

  var worldButton = document.getElementById('worldButton');
  worldButton.addEventListener('click', CCC.tab.bind(null, 'world'), false);
  var logButton = document.getElementById('logButton');
  logButton.addEventListener('click', CCC.tab.bind(null, 'log'), false);
  CCC.tab('log');
  CCC.schedulePing(0);
};

/**
 * Switch between world and log views.
 * @param {string} mode Either 'world' or 'log'.
 */
CCC.tab = function(mode) {
  if (mode == 'world') {
    CCC.worldFrame.style.zIndex = 1;
    CCC.logFrame.style.zIndex = -1;
  } else {
    CCC.logFrame.style.zIndex = 1;
    CCC.worldFrame.style.zIndex = -1;
  }
};

/**
 * Reposition the iframes over the placeholder displayCell.
 * Called when the window changes size.
 */
CCC.resize = function() {
  // Compute the absolute coordinates and dimensions of displayCell.
  var element = CCC.displayCell;
  var x = 0;
  var y = 0;
  do {
    x += element.offsetLeft;
    y += element.offsetTop;
    element = element.offsetParent;
  } while (element);
  // Position both iframes over displayCell.
  CCC.worldFrame.style.left = x + 'px';
  CCC.worldFrame.style.top = y + 'px';
  CCC.worldFrame.style.width = CCC.displayCell.offsetWidth + 'px';
  CCC.worldFrame.style.height = CCC.displayCell.offsetHeight + 'px';
  CCC.logFrame.style.left = x + 'px';
  CCC.logFrame.style.top = y + 'px';
  CCC.logFrame.style.width = CCC.displayCell.offsetWidth + 'px';
  CCC.logFrame.style.height = CCC.displayCell.offsetHeight + 'px';
};

/**
 * Receive messages from our child frames.
 * @param {!Event} e Incoming message event.
 */
CCC.receiveMessage = function(e) {
  var origin = e.origin || e.originalEvent.origin;
  if (origin != location.origin) {
    console.error('Message received by client frame from unknown origin: ' +
                  origin);
    return;
  }
  if (e.data == 'initLog') {
    CCC.countdown();
  } else {
    console.log('Unknown message received by client frame: ' + e.data);
  }
};

/**
 * Distribute a line of text to all frames.
 * @param {string} line Text from Code City.
 */
CCC.distrubuteMessage = function(line) {
  CCC.logFrame.contentWindow.postMessage({mode: 'message', text: line},
                                         location.origin);
};

/**
 * Distribute a command to all frames.
 * @param {string} line Text from user.
 */
CCC.distrubuteCommand = function(line) {
  CCC.logFrame.contentWindow.postMessage({mode: 'command', text: line},
                                         location.origin);
};

/**
 * Add one command to the outbound queue.
 * @param {string} commands Text of user's command.  May be more than one line.
 * @param {boolean} echo True if command to be saved in history.
 */
CCC.sendCommand = function(commands, echo) {
  CCC.lastActiveTime = Date.now();
  CCC.setUnreadLines(0);
  commands = commands.split('\n');
  // A blank line at the end of a multi-line command is usually accidental.
  if (commands.length > 1 && !commands[commands.length-1]) {
    commands.pop();
  }
  for (var i = 0; i < commands.length; i++) {
    // Add command to list of commands to send to server.
    CCC.commandOutput.push(commands[i] + '\n');
    CCC.commandIndex++;
    // Add command to history.
    if (echo) {
      if (!CCC.commandHistory.length ||
          CCC.commandHistory[CCC.commandHistory.length - 1] != commands[i]) {
        CCC.commandHistory.push(commands[i]);
      }
    }
    while (CCC.commandHistory.length > CCC.MAX_HISTORY_SIZE) {
      CCC.commandHistory.shift();
    }
    // Echo command onscreen.
    if (echo) {
      CCC.distrubuteCommand(commands[i]);
    }
  }
  CCC.commandTemp = '';
  CCC.commandHistoryPointer = -1;
  // User is sending command, reset the ping to be frequent.
  CCC.pingInterval = CCC.MIN_PING_INTERVAL;
  // Interrupt any in-flight ping.
  if (CCC.xhrObject) {
    CCC.xhrObject.abort();
    CCC.xhrObject = null;
  }
  CCC.doPing();
};

/**
 * Initiate an XHR network connection.
 */
CCC.doPing = function() {
  if (CCC.xhrObject) {
    // Another ping is currently in progress.
    return;
  }
  // Next ping will be scheduled when this ping completes,
  // but schedule a contingency ping in case of some thrown error.
  CCC.schedulePing(CCC.MAX_PING_INTERVAL + 1);

  var sendingJson = {
    'q': CCC.queueId_
  };
  if (CCC.ackMsgNextPing) {
    sendingJson['ackMsg'] = CCC.messageIndex;
  }
  if (CCC.commandOutput.length) {
    sendingJson['cmdNum'] = CCC.commandIndex;
    sendingJson['cmds'] = CCC.commandOutput;
  }

  // XMLHttpRequest with timeout works in IE8 or better.
  var req = new XMLHttpRequest();
  req.onreadystatechange = CCC.xhrStateChange;
  req.ontimeout = CCC.xhrTimeout;
  req.open('POST', CCC.PING_URL, true);
  req.timeout = CCC.MAX_PING_INTERVAL; // time in milliseconds
  req.setRequestHeader('Content-Type','application/x-www-form-urlencoded');
  req.send(JSON.stringify(sendingJson));
  CCC.xhrObject = req;
  // Let the ping interval creep up.
  CCC.pingInterval = Math.min(CCC.MAX_PING_INTERVAL, CCC.pingInterval * 1.1);
};

/**
 * Timeout function for XHR request.
 * @this {!XMLHttpRequest}
 */
CCC.xhrTimeout = function() {
  console.warn('Connection timeout.');
  CCC.xhrObject = null;
  CCC.schedulePing(CCC.pingInterval);
};

/**
 * Callback function for XHR request.
 * Check network response was ok, then call CCC.parse.
 * @this {!XMLHttpRequest}
 */
CCC.xhrStateChange = function() {
  // Only if request shows "loaded".
  if (this.readyState == 4) {
    CCC.xhrObject = null;
    // Only if "OK".
    if (this.status == 200) {
      try {
        var json = JSON.parse(this.responseText);
      } catch (e) {
        console.log('Invalid JSON: ' + this.responseText);
        return;
      }
      CCC.parse(json);
    } else if (this.status) {
      console.warn('Connection error code: ' + this.status);
      CCC.terminate();
      return;
    }
    CCC.schedulePing(CCC.pingInterval);
  }
};

/**
 * Received an error from the server, indicating that our connection is closed.
 */
CCC.terminate = function() {
  clearTimeout(CCC.nextPingPid);
  // TODO: visualize this better.
  CCC.commandTextarea.disabled = true;
  alert('Game over!');
};

/**
 * Parse the response from the server.
 * @param {!Object} receivedJson Server data.
 */
CCC.parse = function(receivedJson) {
  var ackCmd = receivedJson['ackCmd'];
  var msgNum = receivedJson['msgNum'];
  var msgs = receivedJson['msgs'];

  if (typeof ackCmd == 'number') {
    if (ackCmd > CCC.commandIndex) {
      console.error('Server acks ' + ackCmd +
                    ', but CCC.commandIndex is only ' + CCC.commandIndex);
      CCC.terminate();
    }
    // Server acknowledges receipt of commands.
    // Remove them from the output list.
    CCC.commandOutput.splice(0,
        CCC.commandOutput.length + ackCmd - CCC.commandIndex);
  }

  if (typeof msgNum == 'number') {
    // Server sent messages.  Increase client's index for acknowledgment.
    var currentIndex = msgNum - msgs.length + 1;
    for (var i = 0; i < msgs.length; i++) {
      if (currentIndex > CCC.messageIndex) {
        CCC.messageIndex = currentIndex;
        CCC.distrubuteMessage(msgs[i]);
        // Reduce ping interval.
        CCC.pingInterval =
            Math.max(CCC.MIN_PING_INTERVAL, CCC.pingInterval * 0.8);
      }
      currentIndex++;
    }
    CCC.ackMsgNextPing = true;
  } else {
    CCC.ackMsgNextPing = false;
  }
};

/**
 * Schedule the next ping.
 * @param {number} ms Milliseconds.
 */
CCC.schedulePing = function(ms) {
  clearTimeout(CCC.nextPingPid);
  CCC.nextPingPid = setTimeout(CCC.doPing, ms);
};

/**
 * Monitor the user's keystrokes in the command text area.
 * @param {!Event} e Keydown event.
 */
CCC.keydown = function(e) {
  CCC.lastActiveTime = Date.now();
  CCC.setUnreadLines(0);
  if (!e.shiftKey && e.key == 'Enter') {
    // Enter
    CCC.sendCommand(CCC.commandTextarea.value, CCC.localEcho);
    // Clear the textarea.
    CCC.commandTextarea.value = '';
    CCC.commandHistoryPointer = -1;
    CCC.commandTemp = '';
    e.preventDefault();  // Don't add an enter after the clear.
  } else if ((!e.shiftKey && e.key == 'ArrowUp') ||
             (e.ctrlKey && e.key == 'p')) {
    // Up or Ctrl-P
    if (!CCC.commandHistory.length) {
      return;
    }
    if (CCC.commandHistoryPointer == -1) {
      CCC.commandTemp = CCC.commandTextarea.value;
      CCC.commandHistoryPointer = CCC.commandHistory.length - 1;
      CCC.commandTextarea.value = CCC.commandHistory[CCC.commandHistoryPointer];
    } else if (CCC.commandHistoryPointer > 0) {
      CCC.commandHistoryPointer--;
      CCC.commandTextarea.value = CCC.commandHistory[CCC.commandHistoryPointer];
    }
    e.preventDefault();  // Don't move the cursor to start after change.
  } else if ((!e.shiftKey && e.key == 'ArrowDown') ||
             (e.ctrlKey && e.key == 'n')) {
    // Down or Ctrl-N
    if (!CCC.commandHistory.length) {
      return;
    }
    if (CCC.commandHistoryPointer == CCC.commandHistory.length - 1) {
      CCC.commandHistoryPointer = -1;
      CCC.commandTextarea.value = CCC.commandTemp;
      CCC.commandTemp = '';
    } else if (CCC.commandHistoryPointer >= 0) {
      CCC.commandHistoryPointer++;
      CCC.commandTextarea.value = CCC.commandHistory[CCC.commandHistoryPointer];
    }
  } else if (e.key == 'Tab') {
    // Tab
    e.preventDefault();  // Don't change the focus.
    if (!CCC.commandHistory.length) {
      return;
    }
    var chp = CCC.commandHistoryPointer;
    if (chp == -1) {  // Save the current value.
      CCC.commandTemp = CCC.commandTextarea.value;
    }
    var reverse = e.shiftKey;
    for (var i = 0; i <= CCC.commandHistory.length; i++) {
      // Loop through the entire history, and the current value.
      chp += reverse ? 1 : -1;
      if (chp < -1) {  // Wrap up.
        chp = CCC.commandHistory.length - 1;
      } else if (chp >= CCC.commandHistory.length) {  // Wrap down.
        chp = -1;
      }
      if (chp == -1) {
        // The current value is always a match.
        CCC.commandHistoryPointer = -1;
        CCC.commandTextarea.value = CCC.commandTemp;
        CCC.commandTemp = '';
        break;
      } else if (CCC.commandHistory[chp].toLowerCase()
                 .indexOf(CCC.commandTemp.toLowerCase()) == 0) {
        CCC.commandHistoryPointer = chp;
        CCC.commandTextarea.value = CCC.commandHistory[chp];
        break;
      }
    }
  } else if (e.key.length == 1) {
    CCC.commandHistoryPointer = -1;
    CCC.commandTemp = '';
  }
};

/**
 * Change the number of unread lines, as notified in the title.
 * @param {number} n Number of unread lines.
 */
CCC.setUnreadLines = function(n) {
  CCC.unreadLines = n;
  var title = document.title;
  // Strip off old number.
  title = title.replace(/ \(\d+\)$/, '');
  // Add new number if user hasn't been seen in 10 seconds.
  if (n && CCC.lastActiveTime > Date.now() + 10000) {
    title += ' (' + n + ')';
  }
  document.title = title;
};

window.addEventListener('message', CCC.receiveMessage, false);
window.addEventListener('load', CCC.countdown, false);
