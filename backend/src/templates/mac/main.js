// The whole Mac app: one window with a WebKit view (WKWebView) playing the
// game in Resources/game/index.html. Run by the launcher in Contents/MacOS
// with JavaScript for Automation (osascript -l JavaScript), which drives
// Cocoa directly -- so the app is built on any machine, with no Xcode (see
// exporter.js). Shared by every exported game; only Info.plist, the icon and
// the game change.
ObjC.import('Cocoa');
ObjC.import('WebKit');

// Cocoa constants, by value (enums aren't always bridged).
const ACTIVATION_POLICY_REGULAR = 0;
const WINDOW_STYLE = 1 | 2 | 4 | 8; // titled, closable, miniaturizable, resizable
const BACKING_BUFFERED = 2;
const FULL_SCREEN_PRIMARY = 1 << 7;
const SIZE_TO_WINDOW = 2 | 16; // width and height sizable
const CONTROL_COMMAND = (1 << 18) | (1 << 20);

ObjC.registerSubclass({
  name: 'AskViGameDelegate',
  protocols: ['NSApplicationDelegate'],
  methods: {
    // Closing the game's window quits the game, like the Windows app.
    'applicationShouldTerminateAfterLastWindowClosed:': {
      types: ['bool', ['id']],
      implementation: () => true,
    },
  },
});

function menuItem(title, action, key, modifiers) {
  const item = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent($(title), action, $(key));
  if (modifiers !== undefined) item.setKeyEquivalentModifierMask(modifiers);
  return item;
}

// Just the app menu: hide, full screen and quit, with their usual keys.
function mainMenu(title) {
  const bar = $.NSMenu.alloc.init;
  const appItem = $.NSMenuItem.alloc.init;
  bar.addItem(appItem);
  const menu = $.NSMenu.alloc.init;
  menu.addItem(menuItem(`Hide ${title}`, 'hide:', 'h'));
  menu.addItem(menuItem('Enter Full Screen', 'toggleFullScreen:', 'f', CONTROL_COMMAND));
  menu.addItem($.NSMenuItem.separatorItem);
  menu.addItem(menuItem(`Quit ${title}`, 'terminate:', 'q'));
  appItem.setSubmenu(menu);
  return bar;
}

function run(argv) {
  const resources = argv[0];
  const info = $.NSDictionary.dictionaryWithContentsOfFile($(`${resources}/../Info.plist`));
  const title = info.objectForKey('CFBundleName').js;

  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(ACTIVATION_POLICY_REGULAR);
  const delegate = $.AskViGameDelegate.alloc.init;
  app.setDelegate(delegate);
  app.setMainMenu(mainMenu(title));

  const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0, 0, 1024, 720), WINDOW_STYLE, BACKING_BUFFERED, false);
  win.setTitle($(title));
  win.setCollectionBehavior(FULL_SCREEN_PRIMARY);
  win.center;

  const config = $.WKWebViewConfiguration.alloc.init;
  config.setMediaTypesRequiringUserActionForPlayback(0); // game sound may start on its own
  try {
    // Lets a game file that couldn't be inlined load its neighbours.
    config.preferences.setValueForKey($.NSNumber.numberWithBool(true), $('allowFileAccessFromFileURLs'));
  } catch (e) { /* older WebKit: the inlined game doesn't need it */ }
  const web = $.WKWebView.alloc.initWithFrameConfiguration(win.contentView.bounds, config);
  web.setAutoresizingMask(SIZE_TO_WINDOW);
  web.loadFileURLAllowingReadAccessToURL(
    $.NSURL.fileURLWithPath($(`${resources}/game/index.html`)),
    $.NSURL.fileURLWithPathIsDirectory($(`${resources}/game`), true),
  );
  win.setContentView(web);
  win.makeKeyAndOrderFront(null);
  win.makeFirstResponder(web);

  app.activateIgnoringOtherApps(true);
  app.run;
}
