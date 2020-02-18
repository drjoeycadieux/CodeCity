/**
 * @license
 * Copyright 2018 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Integrated Development Environment for Code City.
 * @author fraser@google.com (Neil Fraser)
 */
'use strict';

Code.Editor = {};

/**
 * JSON-encoded list of complete object selector parts.
 * @type {?string}
 */
Code.Editor.partsJSON = null;

/**
 * Currently selected editor.
 * @type {?Code.GenericEditor}
 */
Code.Editor.currentEditor = null;

/**
 * Current source code for editors that haven't yet been created.
 * @type {string}
 */
Code.Editor.uncreatedEditorSource = '';

/**
 * Got a ping from someone.  Something might have changed and need updating.
 */
Code.Editor.receiveMessage = function() {
  if (Code.Editor.isSaveDialogVisible) {
    return;  // Ignore messages if the modal save dialog is up.
  }
  var selector = sessionStorage.getItem(Code.Common.SELECTOR);
  var parts = Code.Common.selectorToParts(selector);
  if (!parts || !parts.length) {
    return;  // Invalid parts, ignore.
  }
  if (JSON.stringify(parts) === Code.Editor.partsJSON) {
    return;  // No change.
  }
  if (Code.Editor.partsJSON === null) {
    Code.Editor.load();  // Initial load of content.
  } else {
    Code.Editor.updateCurrentSource();
    if (Code.Editor.currentSource === Code.Editor.originalSource) {
      Code.Editor.reload();  // Reload to load different content.
    } else {
      Code.Editor.showSave();  // User needs to save/discard/cancel.
    }
  }
};

/**
 * Page has loaded, initialize the editor.
 */
Code.Editor.init = function() {
  // Initialize button handlers.
  document.getElementById('editorConfirmDiscard').addEventListener('click',
      Code.Editor.reload);
  document.getElementById('editorConfirmCancel').addEventListener('click',
      Code.Editor.hideDialog);
  document.getElementById('editorConfirmSave').addEventListener('click',
      Code.Editor.save);
  document.getElementById('editorSave').addEventListener('click',
      Code.Editor.save);
  document.getElementById('editorShare').addEventListener('click',
      Code.Editor.showShare);
  document.getElementById('editorShareOk').addEventListener('click',
      Code.Editor.hideDialog);
  document.getElementById('editorShareCheck').addEventListener('change',
      Code.Editor.checkShare);


  // Create the tabs.
  var tabRow = document.getElementById('editorTabs');
  var containerRow = document.getElementById('editorContainers');
  for (var i = 0, editor; (editor = Code.Editor.editors[i]); i++) {
    var span = document.createElement('span');
    span.className = 'jfk-button';
    span.appendChild(document.createTextNode(editor.name));
    span.setAttribute('role', 'button');
    span.setAttribute('tabindex', i);
    span.addEventListener('click', Code.Editor.tabClick);
    tabRow.appendChild(span);
    var spacer = document.createElement('span');
    spacer.className = 'spacer';
    tabRow.appendChild(spacer);
    var div = document.createElement('div');
    containerRow.appendChild(div);
    // Cross-link span/div to editor.
    span.editor = editor;
    div.editor = editor;
    editor.tabElement = span;
    editor.containerElement = div;
  }

  Code.Editor.receiveMessage();
};

/**
 * Load content into the editors.
 */
Code.Editor.load = function() {
  var selector = sessionStorage.getItem(Code.Common.SELECTOR);
  var parts = Code.Common.selectorToParts(selector);
  if (!parts) {
    return;  // Invalid parts, ignore.
  }
  Code.Editor.partsJSON = JSON.stringify(parts);
  // Request data from Code City server.
  Code.Editor.key = undefined;
  Code.Editor.sendXhr();

  // Set the header.
  var header = document.getElementById('editorHeader');
  header.innerHTML = '';
  if (parts.length < 2) {
    // Global object.
    var reference = Code.Common.partsToSelector(parts) + ' = ';
  } else {
    // Remove the last part.
    var lastPart = parts.pop();
    var selector = Code.Common.partsToSelector(parts);
    var reference = Code.Common.selectorToReference(selector);
    // Put the last part back on.
    // Render as '.foo' or '[42]' or '["???"]' or '^'.
    if (lastPart.type === 'id') {
      var mockParts = [{type: 'id', value: 'X'}, lastPart];
      reference += Code.Common.partsToSelector(mockParts).substring(1) + ' = ';
    } else if (lastPart.type === '^') {
      reference = 'Object.setPrototypeOf(' + reference + ', ...) ';
    } else {
      // Unknown part type.
      throw new TypeError(lastPart);
    }
  }
  header.appendChild(document.createTextNode(reference));
};

/**
 * Check the currently active editor and update Code.Editor.currentSource
 * if there has been a change.
 */
Code.Editor.updateCurrentSource = function() {
  if (Code.Editor.currentEditor && !Code.Editor.currentEditor.isSaved()) {
    Code.Editor.currentSource = Code.Editor.currentEditor.getSource();
  }
  if (!Code.Editor.isSaveDialogVisible) {
    Code.Editor.saturateSave(
        Code.Editor.currentSource !== Code.Editor.originalSource);
  }
};

/**
 * Save the current editor content.
 */
Code.Editor.save = function() {
  Code.Editor.updateCurrentSource();
  Code.Editor.sendXhr();
  // Prevent the user from interacting with the editor during an async save.
  // TODO: Implement merging.
  var mask = document.getElementById('editorSavingMask');
  mask.style.display = 'block';
  Code.Editor.saveMaskPid = setTimeout(function() {
    mask.style.opacity = 0.2;
  }, 1000);  // Wait a second before starting visible transition.
};

/**
 * Force a reload of this editor.  Used to switch to edit something else.
 */
Code.Editor.reload = function() {
  Code.Editor.hideDialog();
  Code.Editor.beforeUnload.disabled = true;
  location.reload();
};

/**
 * Issue a warning if the user has unsaved changes and is attempting to leave
 * the code editor (e.g. typing a new URL).  This is not triggered due to
 * in-editor navigation.
 * @param {!Event} e A beforeunload event.
 */
Code.Editor.beforeUnload = function(e) {
  if (Code.Editor.isSaveDialogVisible) {
    // The user has already got a warning but is ignoring it.  Just leave.
    Code.Editor.hideDialog();
    return;
  }
  Code.Editor.updateCurrentSource();
  if (!Code.Editor.beforeUnload.disabled &&
      Code.Editor.currentSource !== Code.Editor.originalSource) {
    e.returnValue = 'You have unsaved changes.';
    e.preventDefault();
  }
};

/**
 * Flag to allow navigation away from current page, despite unsaved changes.
 */
Code.Editor.beforeUnload.disabled = false;

/**
 * Asynchronously load MobWrite's JavaScript files.
 * @param {!Function} callback Function to call when MobWrite is loaded.
 */
Code.Editor.loadMobWrite = function(callback) {
  if (!Code.Editor.waitMobWrite_.isLoaded) {
    var files = ['dmp.js', 'mobwrite_core.js', 'mobwrite_cc.js'];
    for (var i = 0; i < files.length; i++) {
      var script = document.createElement('script');
      script.src = 'mobwrite/' + files[i];
      document.head.appendChild(script);
    }
  }
  Code.Editor.waitMobWrite_(callback);
};

/**
 * Wait for MobWrite to load.  Initialize it, then run the callback.
 * @param {!Function} callback Function to call when MobWrite is loaded.
 * @private
 */
Code.Editor.waitMobWrite_ = function(callback) {
  if (typeof diff_match_patch === 'undefined' ||
      typeof mobwrite === 'undefined' ||
      typeof Code.MobwriteShare === 'undefined') {
    // Not loaded, try again later.
    setTimeout(Code.Editor.waitMobWrite_, 50, callback);
  } else {
    if (!Code.Editor.waitMobWrite_.isLoaded) {
      Code.MobwriteShare.init();
      Code.Editor.waitMobWrite_.isLoaded = true;
    }
    callback();
  }
};

Code.Editor.waitMobWrite_.isLoaded = false;

/**
 * When a tab is clicked, highlight it and show its container.
 * @param {!Event|!Object} e Click event or object pretending to be an event.
 */
Code.Editor.tabClick = function(e) {
  if (Code.Editor.tabClick.disabled) {
    return;
  }

  // Unhighlight all tabs, hide all containers.
  var tab = document.querySelector('#editorTabs>.highlighted');
  tab && tab.classList.remove('highlighted');
  var containers = document.querySelectorAll('#editorContainers>div');
  for (var container of containers) {
    container.style.display = 'none';
  }

  Code.Editor.updateCurrentSource();

  // Highlight one tab, show one container.
  var tab = e.target;
  tab.classList.add('highlighted');
  var editor = tab.editor;
  Code.Editor.currentEditor = editor;
  var container = editor.containerElement;
  if (!editor.created) {
    editor.createDom(container);
    editor.created = true;
  }
  container.style.display = 'block';
  Code.Editor.setSourceToAllEditors(Code.Editor.currentSource);
  // If e is an event, then this click is the result of a user's direct action.
  // If not, then it's a fake event as a result of page load.
  var userAction = e instanceof Event;
  editor.focus(userAction);
};

/**
 * Don't allow clicking of tabs before data is received from Code City.
 */
Code.Editor.tabClick.disabled = true;

/**
 * Send a request to Code City's code editor service.
 */
Code.Editor.sendXhr = function() {
  var xhr = Code.Editor.codeRequest_;
  xhr.abort();
  xhr.open('POST', '/code/editor');
  xhr.setRequestHeader('Content-type', 'application/x-www-form-urlencoded');
  xhr.onload = Code.Editor.receiveXhr;
  var src = Code.Editor.currentSource || '';
  var data =
      'key=' + encodeURIComponent(Code.Editor.key) +
      '&parts=' + encodeURIComponent(Code.Editor.partsJSON);
  if (src) {
    data += '&src=' + encodeURIComponent(src);
  }
  xhr.send(data);
};

/**
 * Reusable XHR object for server pings.
 */
Code.Editor.codeRequest_ = new XMLHttpRequest();

/**
 * Got a response from Code City's code editor service.
 */
Code.Editor.receiveXhr = function() {
  var xhr = Code.Editor.codeRequest_;
  if (xhr.status !== 200) {
    console.warn('Editor XHR returned status ' + xhr.status);
    return;
  }
  var data = JSON.parse(xhr.responseText);
  if (data.hasOwnProperty('key')) {
    Code.Editor.key = data.key;
  }
  if (data.hasOwnProperty('src')) {
    Code.Editor.originalSource = data.src;
    // Only update the displayed source if a) this is the initial load,
    // or b) the previous save was successful.
    if (Code.Editor.currentSource === null || data.saved) {
      Code.Editor.currentSource = data.src;
      Code.Editor.setSourceToAllEditors(data.src);
    }
  }
  // Remove saving mask.
  clearTimeout(Code.Editor.saveMaskPid);
  var mask = document.getElementById('editorSavingMask');
  mask.style.display = 'none';
  mask.style.opacity = 0;

  // While a save is in-flight, the user might have navigated away and be
  // currently blocked by a warning dialog regarding unsaved work.
  if (Code.Editor.isSaveDialogVisible) {
    if (data.saved) {
      // If the save was successful, then proceed with the requested navigation.
      Code.Editor.reload();
    } else {
      // If the save was not successful, close the dialog and hope there's some
      // butter to show.
      Code.Editor.hideDialog();
    }
  }

  // If there's a message, show it in the butter.
  if (data.butter) {
    Code.Editor.showButter(data.butter, 5000);
  }

  Code.Editor.ready && Code.Editor.ready();
};

/**
 * The original source text from the server.
 * @type {?string}
 */
Code.Editor.originalSource = null;

/**
 * Current source text from the most recent active editor.
 * @type {?string}
 */
Code.Editor.currentSource = null;

/**
 * Data has been received, ready to allow the user to edit.
 */
Code.Editor.ready = function() {
  // Configure tabs.
  document.getElementById('editorTabs').classList.remove('disabled');
  Code.Editor.tabClick.disabled = false;

  // Switch tabs to show the highest confidence editor.
  var bestEditor = Code.Editor.mostConfidentEditor();
  if (bestEditor) {
    var fakeEvent = {target: bestEditor.tabElement};
    Code.Editor.tabClick(fakeEvent);
  }

  // Remove the loading animation.
  var header = document.getElementById('editorHeader');
  header.className = '';

  // Update the save button's saturation state once a second.
  setInterval(Code.Editor.updateCurrentSource, 1000);

  var hash = parent && parent.location && parent.location.hash;
  if (hash.length > 1) {
    Code.Editor.loadMobWrite(function() {
      mobwrite.share('Code');
    });
  }

  // Only run this code once.
  Code.Editor.ready = undefined;
};


/**
 * Find the editor with the highest confidence for the current text.
 * Confidence levels are recorded when text is set in each editor.
 * @return {Code.GenericEditor} Best editor, or null if none.
 */
Code.Editor.mostConfidentEditor = function() {
  var bestEditor = null;
  var bestConfidence = -Infinity;
  for (var editor of Code.Editor.editors) {
    if (bestConfidence < editor.confidence) {
      bestConfidence = editor.confidence;
      bestEditor = editor;
    }
  }
  return bestEditor;
};

/**
 * Set the values of all the editors.
 * @param {string} src Plain text contents.
 */
Code.Editor.setSourceToAllEditors = function(src) {
  Code.Editor.uncreatedEditorSource = src;
  for (var editor of Code.Editor.editors) {
    editor.setSource(src);
    // Round-trip version of the source.
    editor.unmodifiedSource = editor.getSource();
  }
};

/**
 * Show the save dialog.
 */
Code.Editor.showSave = function() {
  Code.Editor.showDialog('editorConfirmBox');
  // Desaturate save button.  Don't visually conflict with the 'save' button
  // in save dialog.
  Code.Editor.saturateSave(false);
  Code.Editor.isSaveDialogVisible = true;
};

/**
 * Show the share dialog.
 */
Code.Editor.showShare = function() {
  Code.Editor.showDialog('editorShareBox');
  document.body.style.cursor = 'wait';
  Code.Editor.loadMobWrite(Code.Editor.populateShare);
};

/**
 * Show the share dialog.
 */
Code.Editor.populateShare = function() {
  document.body.style.cursor = '';
  document.getElementById('editorShareBox').className = '';
  var check = document.getElementById('editorShareCheck');
  check.disabled = '';
  check.checked = !!Object.keys(mobwrite.shared).length;
  Code.Editor.checkShare();
};

/**
 * Called when the sharing checkbox is ticked or unticked.
 */
Code.Editor.checkShare = function() {
  var check = document.getElementById('editorShareCheck');
  var input = document.getElementById('editorShareAddress');
  input.disabled = !check.checked;

  var shared = !!Object.keys(mobwrite.shared).length;
  var hash = '#';
  if (check.checked) {
    if (!shared) {
      mobwrite.share('Code');
    }
    hash += Code.MobwriteShare.id;
  } else if (!check.checked) {
    if (shared) {
      mobwrite.unshare('Code');
    }
  }
  if (parent && parent.history) {
    // Update the URL on the parent frame.
    parent.history.replaceState(undefined, undefined, hash);
    // Update the address field the user can copy from.
    input.value = check.checked ? parent.location : '';
    input.select();
  }
};

/**
 * Show a dialog.
 * @param {string} contentId ID of dialog's content div.
 */
Code.Editor.showDialog = function(contentId) {
  // Clean up and hide existing things that might be visible.
  clearTimeout(Code.Editor.dialogAnimationPid);
  Code.Editor.hideButter();
  document.getElementById('editorConfirmBox').style.display = 'none';
  document.getElementById('editorShareBox').style.display = 'none';
  // Show the requested dialog.
  document.getElementById(contentId).style.display = 'block';
  document.getElementById('editorDialog').style.display = 'block';
  var mask = document.getElementById('editorDialogMask');
  var box = document.getElementById('editorDialogBox');
  box.style.display = 'block';
  mask.style.transitionDuration = '.4s';
  box.style.transitionDuration = '.4s';
  // Add a little bounce at the end of the animation.
  box.style.transitionTimingFunction = 'cubic-bezier(.6,1.36,.75,1)';
  Code.Editor.dialogAnimationPid = setTimeout(function() {
    mask.style.opacity = 0.2;
    box.style.top = '-10px';
  }, 100);  // Firefox requires at least 10ms to process this timing function.
};

/**
 * Hide the dialog.
 */
Code.Editor.hideDialog = function() {
  clearTimeout(Code.Editor.dialogAnimationPid);
  var mask = document.getElementById('editorDialogMask');
  var box = document.getElementById('editorDialogBox');
  mask.style.transitionDuration = '.2s';
  box.style.transitionDuration = '.2s';
  box.style.transitionTimingFunction = 'ease-in';
  mask.style.opacity = 0;
  box.style.top = '-120px';
  Code.Editor.dialogAnimationPid = setTimeout(function() {
    document.getElementById('editorDialog').style.display = 'none';
    box.style.display = 'none';
    document.getElementById('editorConfirmBox').style.display = 'none';
    document.getElementById('editorShareBox').style.display = 'none';
  }, 250);
  // Resaturate the save button.
  Code.Editor.saturateSave(true);
  Code.Editor.isSaveDialogVisible = false;
};

/**
 * Is the save dialog currently visible?
 */
Code.Editor.isSaveDialogVisible = false;

/**
 * PID of any animation task.  Allows animations to be canceled so that two
 * near-simultaneous actions don't collide.
 */
Code.Editor.dialogAnimationPid = 0;

/**
 * Saturate or desaturate the editor's save button.
 * @param {boolean} saturated True if button should be saturated.
 */
Code.Editor.saturateSave = function(saturated) {
  var button = document.getElementById('editorSave');
  button.className = saturated ? 'jfk-button jfk-button-submit' : 'jfk-button';
};

/**
 * Show the text in the butter bar for a period of time.
 * Clobber any existing display.
 * @param {string} text Text to display.
 * @param {number} time Number of milliseconds to display butter.
 */
Code.Editor.showButter = function(text, time) {
  clearTimeout(Code.Editor.showButter.pid_);
  var textDiv = document.getElementById('editorButterText');
  textDiv.innerHTML = '';
  textDiv.appendChild(document.createTextNode(text));
  document.getElementById('editorButter').style.display = 'block';
  Code.Editor.showButter.pid_ = setTimeout(Code.Editor.hideButter, time);
};

Code.Editor.showButter.pid_ = 0;

/**
 * Hide the butter bar.
 */
Code.Editor.hideButter = function() {
  document.getElementById('editorButter').style.display = 'none';
};

if (!window.TEST) {
  window.addEventListener('load', Code.Editor.init);
  window.addEventListener('message', Code.Editor.receiveMessage, false);
  window.addEventListener('beforeunload', Code.Editor.beforeUnload);
}

Code.Editor.editors = [];

/**
 * Base class for editors.
 * @param {string} name User-facing name of editor (used in tab).
 * @constructor
 */
Code.GenericEditor = function(name) {
  /**
   * Human-readable name of editor.
   * @type {string}
   */
  this.name = name;

  /**
   * A float from 0 (bad) to 1 (perfect) indicating the editor's fitness to
   * edit the given content.
   */
  this.confidence = 0;

  /**
   * Has the DOM for this editor been created yet?
   */
  this.created = false;

  /**
   * Span that forms the tab button.
   * @type {?Element}
   */
  this.tabElement = null;

  /**
   * Div that forms the editor's container.
   * @type {?Element}
   */
  this.containerElement = null;

  /**
   * Plain text representation of this editor's contents as of load or last save.
   * @type {?string}
   */
  this.unmodifiedSource = null;

  // Register this editor.
  Code.Editor.editors.push(this);
};

/**
 * Create the DOM for this editor.
 * @param {!Element} container DOM should be appended to this containing div.
 */
Code.GenericEditor.prototype.createDom = function(container) {
  var text = 'TODO: Implement createDom for ' + this.name + ' editor.';
  container.appendChild(document.createTextNode(text));
};

/**
 * Get the contents of the editor.
 * @return {string} Plain text contents.
 */
Code.GenericEditor.prototype.getSource = function() {
  throw new ReferenceError('getSource not implemented on editor');
};

/**
 * Set the contents of the editor.
 * @param {string} source Plain text contents.
 */
Code.GenericEditor.prototype.setSource = function(source) {
  throw new ReferenceError('setSource not implemented on editor');
};

/**
 * Is the user's work in this editor saved?
 * @return {boolean} True if work is saved.
 */
Code.GenericEditor.prototype.isSaved = function() {
  return this.getSource() === this.unmodifiedSource;
};

/**
 * Notification that this editor has just been displayed.
 * @param {boolean} userAction True if user clicked on a tab.
 */
Code.GenericEditor.prototype.focus = function(userAction) {
};


////////////////////////////////////////////////////////////////////////////////
Code.valueEditor = new Code.GenericEditor('Value');

// The value editor can handle any content, but express a low confidence in
// order to defer to more specialized editors.
Code.valueEditor.confidence = 0.1;

/**
 * Code Mirror editor.  Does not exist until tab is selected.
 * @type {Object}
 * @private
 */
Code.valueEditor.editor_ = null;

/**
 * Create the DOM for this editor.
 * @param {!Element} container DOM should be appended to this containing div.
 */
Code.valueEditor.createDom = function(container) {
  container.id = 'valueEditor';
  var options = {
    tabSize: 2,
    undoDepth: 1024,
    lineNumbers: true,
    matchBrackets: true
  };
  this.editor_ = CodeMirror(container, options);
  this.editor_.setSize('100%', '100%');
};

/**
 * Get the contents of the editor.
 * @return {string} Plain text contents.
 */
Code.valueEditor.getSource = function() {
  return this.created ?
      this.editor_.getValue() : Code.Editor.uncreatedEditorSource;
};

/**
 * Set the contents of the editor.
 * @param {string} source Plain text contents.
 */
Code.valueEditor.setSource = function(source) {
  if (this.created) {
    this.editor_.setValue(source);
  }
};

/**
 * Notification that this editor has just been displayed.
 * @param {boolean} userAction True if user clicked on a tab.
 */
Code.valueEditor.focus = function(userAction) {
  this.editor_.refresh();
  if (userAction) {
    this.editor_.focus();
  }
};

////////////////////////////////////////////////////////////////////////////////
Code.functionEditor = new Code.GenericEditor('Function');

/**
 * Code Mirror editor.  Does not exist until tab is selected.
 * @type {Object}
 * @private
 */
Code.functionEditor.editor_ = null;

/**
 * Create the DOM for this editor.
 * @param {!Element} container DOM should be appended to this containing div.
 */
Code.functionEditor.createDom = function(container) {
  container.innerHTML = `
<div>
  <input type="checkbox" name="isVerb" id="isVerb"
      onclick="Code.functionEditor.updateDisabled()">
  <label for="isVerb">Verb:</label>
  <input id="verb" value="" placeholder="name">
  <select id="dobj">
    <option>none</option>
    <option>this</option>
    <option>any</option>
  </select>
  <select id="prep">
    <option>none</option>
    <option>any</option>
    <option>with/using</option>
    <option>at/to</option>
    <option>in front of</option>
    <option>in/inside/into</option>
    <option>on top of/on/onto/upon</option>
    <option>out of/from inside/from</option>
    <option>over</option>
    <option>through</option>
    <option>under/underneath/beneath</option>
    <option>behind</option>
    <option>beside</option>
    <option>for/about</option>
    <option>is</option>
    <option>as</option>
    <option>off/off of</option>
  </select>
  <select id="iobj">
    <option>none</option>
    <option>this</option>
    <option>any</option>
  </select>
</div>
  `;
  container.id = 'functionEditor';
  var options = {
    tabSize: 2,
    undoDepth: 1024,
    lineNumbers: true,
    continueComments: {continueLineComment: false},
    mode: 'text/javascript',
    matchBrackets: true
  };
  this.editor_ = CodeMirror(container, options);
  this.editor_.setSize('100%', '100%');

  this.isVerbElement_ = document.getElementById('isVerb');
  this.verbElement_ = document.getElementById('verb');
  this.dobjElement_ = document.getElementById('dobj');
  this.prepElement_ = document.getElementById('prep');
  this.iobjElement_ = document.getElementById('iobj');
};

// Matches the signature of a function declaration.
// Split the source into leading meta-data comments and function body.
Code.functionEditor.functionRegex_ =
    /^((?:[ \t]*(?:\/\/[^\n]*)?\n)*)\s*(function[\S\s]*)$/;

/**
 * Enable or disable the verb UI elements based on the isVerb checkbox.
 */
Code.functionEditor.updateDisabled = function() {
  var disabled = this.isVerbElement_.checked ? '' : 'disabled';
  this.verbElement_.disabled = disabled;
  this.dobjElement_.disabled = disabled;
  this.prepElement_.disabled = disabled;
  this.iobjElement_.disabled = disabled;
};

/**
 * Get the contents of the editor.
 * @return {string} Plain text contents.
 */
Code.functionEditor.getSource = function() {
  if (!this.created) {
    return Code.Editor.uncreatedEditorSource;
  }
  var source = this.editor_.getValue();
  var verb = '@delete_prop verb';
  var dobj = '@delete_prop dobj';
  var prep = '@delete_prop prep';
  var iobj = '@delete_prop iobj';
  if (this.isVerbElement_.checked) {
    verb = '@set_prop verb = ' + JSON.stringify(this.verbElement_.value);
    dobj = '@set_prop dobj = ' + JSON.stringify(this.dobjElement_.value);
    prep = '@set_prop prep = ' + JSON.stringify(this.prepElement_.value);
    iobj = '@set_prop iobj = ' + JSON.stringify(this.iobjElement_.value);
  }
  return `
// @copy_properties true
// ${verb}
// ${dobj}
// ${prep}
// ${iobj}
${source}
  `.trim();
};

/**
 * Set the contents of the editor.
 * @param {string} source Plain text contents.
 */
Code.functionEditor.setSource = function(source) {
  var m = source.match(Code.functionEditor.functionRegex_);
  this.confidence = m ? 0.5 : 0;
  if (this.created) {
    var meta;
    if (m) {
      meta = m[1].split(/\n/);
      source = m[2];
    } else {
      meta = '';
      source = 'function() {\n}';
    }
    var props = {
      'verb': '',
      'dobj': 'none',
      'prep': 'none',
      'iobj': 'none'
    };
    var isVerb = false;
    for (var line of meta) {
      var m = line.match(Code.functionEditor.setSource.metaRegex_);
      if (m) {
        try {
          props[m[1]] = JSON.parse(m[2]);
          isVerb = true;
        } catch (e) {
          console.log('Ignoring invalid ' + m[1] + ': ' + m[2]);
        }
      }
    }
    this.verbElement_.value = props['verb'];
    this.dobjElement_.value = props['dobj'];
    this.prepElement_.value = props['prep'];
    this.iobjElement_.value = props['iobj'];
    this.isVerbElement_.checked = isVerb;
    this.updateDisabled();
    this.editor_.setValue(source);
  }
};

// Matches one meta-data comment:  // @set_prop verb = "foobar"
Code.functionEditor.setSource.metaRegex_ =
    /^\s*\/\/\s*@set_prop\s+(verb|dobj|prep|iobj)\s*=\s*(.+)$/;

/**
 * Notification that this editor has just been displayed.
 * @param {boolean} userAction True if user clicked on a tab.
 */
Code.functionEditor.focus = function(userAction) {
  this.editor_.refresh();
  if (userAction) {
    this.editor_.focus();
  }
};

////////////////////////////////////////////////////////////////////////////////
Code.jsspEditor = new Code.GenericEditor('JSSP');

/**
 * JavaScript Server Page editor.  Does not exist until tab is selected.
 * @type {Object}
 * @private
 */
Code.jsspEditor.editor_ = null;

/**
 * Create the DOM for this editor.
 * @param {!Element} container DOM should be appended to this containing div.
 */
Code.jsspEditor.createDom = function(container) {
  container.id = 'jsspEditor';
  var options = {
    tabSize: 2,
    undoDepth: 1024,
    lineNumbers: true,
    continueComments: 'Enter',
    mode: 'application/x-ejs',
    matchBrackets: true
  };
  this.editor_ = CodeMirror(container, options);
  this.editor_.setSize('100%', '100%');
};

/**
 * Get the contents of the editor.
 * @return {string} Plain text contents.
 */
Code.jsspEditor.getSource = function() {
  if (!this.created) {
    return Code.Editor.uncreatedEditorSource;
  }
  var source = this.editor_.getValue();
  return JSON.stringify(source);
};

/**
 * Set the contents of the editor.
 * @param {string} source Plain text contents.
 */
Code.jsspEditor.setSource = function(source) {
  var str;
  try {
    str = JSON.parse(source);
  } catch (e) {}
  if (typeof str !== 'string') {
    str = '';
    this.confidence = 0;
  } else {
    if (str.indexOf('<%') !== -1 && str.indexOf('%>') !== -1) {
      this.confidence = 0.95;
    } else {
      this.confidence = 0.8;
    }
  }
  if (this.created) {
    this.editor_.setValue(str);
  }
};

/**
 * Notification that this editor has just been displayed.
 * @param {boolean} userAction True if user clicked on a tab.
 */
Code.jsspEditor.focus = function(userAction) {
  this.editor_.refresh();
  if (userAction) {
    this.editor_.focus();
  }
};

////////////////////////////////////////////////////////////////////////////////
Code.svgEditor = new Code.GenericEditor('SVG');

/**
 * DOMParser used to determine if the source is SVG.
 */
Code.svgEditor.parser = new DOMParser();

/**
 * Create the DOM for this editor.
 * @param {!Element} container DOM should be appended to this containing div.
 */
Code.svgEditor.createDom = function(container) {
  container.innerHTML = `
<div style="position: absolute; top: 60px; bottom: 0; left: 0; right: 0; overflow: hidden;">
  <iframe src="/static/code/svg.html" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: 0"></iframe>
</div>
  `;
  this.frameWindow_ = container.querySelector('iframe').contentWindow;
};

/**
 * Get the contents of the editor.
 * @return {string} Plain text contents.
 */
Code.svgEditor.getSource = function() {
  if (!this.created) {
    return Code.Editor.uncreatedEditorSource;
  }
  var xmlString = this.frameWindow_.hasOwnProperty('initialSource') ?
      this.frameWindow_.initialSource :
      this.frameWindow_.svgEditor.getString();
  return JSON.stringify(xmlString);
};

/**
 * Set the contents of the editor.
 * @param {string} text Plain text contents.
 */
Code.svgEditor.setSource = function(source) {
  var str = undefined;
  this.confidence = 0;
  try {
    str = JSON.parse(source);
  } catch (e) {}
  if (typeof str === 'string') {
    // DOMParser needs contents wrapped in a parent SVG node.
    var dom = Code.svgEditor.parser.parseFromString('<svg>' + str + '</svg>',
        'text/xml');
    // Let's see if this DOM contains only SVG tags.
    var nodes = dom.documentElement.querySelectorAll('*');
    var isSvg = nodes.length > 0;
    for (var node of nodes) {
      if (Code.svgEditor.ELEMENT_NAMES.indexOf(node.tagName) === -1) {
        isSvg = false;
        break;
      }
    }
    if (isSvg) {
      this.confidence = 0.95;
    } else {
      str = '';
    }
  } else {
    str = '';
  }

  if (this.created) {
    if (this.frameWindow_.svgEditor) {
      this.frameWindow_.svgEditor.setString(str);
    } else {
      // The iframe exists, but the editor hasn't loaded yet.
      // Save the source in a property on the iframe, so it can load when ready.
      this.frameWindow_.initialSource = str;
    }
  }
};

/**
 * Notification that this editor has just been displayed.
 * @param {boolean} userAction True if user clicked on a tab.
 */
Code.svgEditor.focus = function(userAction) {
  if (userAction && this.frameWindow_.svgEditor) {
    // Window may have resized since this tab was last visible.
    this.frameWindow_.svgEditor.resize();
  }
};

/**
 * Whitelist of all allowed SVG element names.
 * Try to keep this list in sync with CCC.World.xmlToSvg.ELEMENT_NAMES.
 */
Code.svgEditor.ELEMENT_NAMES = [
  'circle',
  'desc',
  'ellipse',
  'g',
  'line',
  'path',
  'polygon',
  'polyline',
  'rect',
  'svg',
  'text',
  'title',
  'tspan',
];

////////////////////////////////////////////////////////////////////////////////
Code.stringEditor = new Code.GenericEditor('String');

/**
 * Create the DOM for this editor.
 * @param {!Element} container DOM should be appended to this containing div.
 */
Code.stringEditor.createDom = function(container) {
  container.innerHTML = `
<div style="position: absolute; top: 60px; bottom: 20px; left: 45px; right: 50px">
  <textarea style="height: 100%; width: 100%; resize: none;"></textarea>
</div>
<div class="editorBigQuotes" style="left: 10px; top: 57px">“</div>
<div class="editorBigQuotes" style="right: 10px; bottom: 0">”</div>
  `;
  this.textarea_ = container.querySelector('textarea');
};

/**
 * Get the contents of the editor.
 * @return {string} Plain text contents.
 */
Code.stringEditor.getSource = function() {
  return this.created ?
      JSON.stringify(this.textarea_.value) :
      Code.Editor.uncreatedEditorSource;
};

/**
 * Set the contents of the editor.
 * @param {string} text Plain text contents.
 */
Code.stringEditor.setSource = function(source) {
  var str;
  try {
    str = JSON.parse(source);
  } catch (e) {}
  if (typeof str !== 'string') {
    str = '';
    this.confidence = 0;
  } else {
    this.confidence = 0.9;
  }
  if (this.created) {
    this.textarea_.value = str;
  }
};

/**
 * Notification that this editor has just been displayed.
 * @param {boolean} userAction True if user clicked on a tab.
 */
Code.stringEditor.focus = function(userAction) {
  if (userAction) {
    this.textarea_.focus();
  }
};

////////////////////////////////////////////////////////////////////////////////
//Code.regExpEditor = new Code.GenericEditor('RegExp');

////////////////////////////////////////////////////////////////////////////////
//Code.dateEditor = new Code.GenericEditor('Date');

////////////////////////////////////////////////////////////////////////////////
Code.diffEditor = new Code.GenericEditor('Diff');

/**
 * Create the DOM for this editor.
 * @param {!Element} container DOM should be appended to this containing div.
 */
Code.diffEditor.createDom = function(container) {
  container.innerHTML = `
<div style="position: absolute; top: 60px; bottom: 0; left: 0; right: 0; overflow: hidden;">
  <iframe src="/static/code/diff.html" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: 0"></iframe>
</div>
  `;
  this.frameWindow_ = container.querySelector('iframe').contentWindow;
};

/**
 * Get the contents of the editor.
 * @return {string} Plain text contents.
 */
Code.diffEditor.getSource = function() {
  if (!this.created) {
    return Code.Editor.uncreatedEditorSource;
  }
  if (this.frameWindow_.hasOwnProperty('initialSource')) {
    return this.frameWindow_.initialSource;
  }
  return this.frameWindow_.diffEditor.getString();
};

/**
 * Set the contents of the editor.
 * @param {string} source Plain text contents.
 */
Code.diffEditor.setSource = function(source) {
  if (this.created) {
    if (this.frameWindow_.diffEditor) {
      this.frameWindow_.diffEditor.setString(source, Code.Editor.originalSource);
    } else {
      // The iframe exists, but the editor hasn't loaded yet.
      // Save the source in a property on the iframe, so it can load when ready.
      this.frameWindow_.initialSource = source;
      this.frameWindow_.originalSource = Code.Editor.originalSource;
    }
  }
};
