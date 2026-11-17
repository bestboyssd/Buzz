import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const cameraPluginPath = path.join(
  root,
  'node_modules/@capacitor/camera/android/src/main/java/com/capacitorjs/plugins/camera/CameraPlugin.kt'
);
if (fs.existsSync(cameraPluginPath)) {
  let content = fs.readFileSync(cameraPluginPath, 'utf8');
  content = content
    .replace('private const val CAMERA = "camera"', 'const val CAMERA = "camera"')
    .replace('private const val PHOTOS = "photos"', 'const val PHOTOS = "photos"')
    .replace('private const val SAVE_GALLERY = "saveGallery"', 'const val SAVE_GALLERY = "saveGallery"')
    .replace(
      'private const val READ_EXTERNAL_STORAGE = "readExternalStorage"',
      'const val READ_EXTERNAL_STORAGE = "readExternalStorage"'
    );
  fs.writeFileSync(cameraPluginPath, content, 'utf8');
}

const ionCameraFlowPath = path.join(
  root,
  'node_modules/@capacitor/camera/android/src/main/java/com/capacitorjs/plugins/camera/IonCameraFlow.kt'
);
if (fs.existsSync(ionCameraFlowPath)) {
  let content = fs.readFileSync(ionCameraFlowPath, 'utf8');
  content = content.replace(
    '                processResultEditFromGallery(intent)\n                lastEditUri = null',
    '                intent?.let { processResultEditFromGallery(it) }\n                lastEditUri = null'
  );
  fs.writeFileSync(ionCameraFlowPath, content, 'utf8');
}

const capacitorWebViewPath = path.join(
  root,
  'node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/CapacitorWebView.java'
);
if (fs.existsSync(capacitorWebViewPath)) {
  let content = fs.readFileSync(capacitorWebViewPath, 'utf8');
  if (!content.includes('TYPE_TEXT_FLAG_NO_SUGGESTIONS')) {
    content = content.replace(
      '        return super.onCreateInputConnection(outAttrs);',
      `        InputConnection ic = super.onCreateInputConnection(outAttrs);
        if (outAttrs != null) {
            // Strip out NO_SUGGESTIONS so Gboard/system keyboards always show candidate words
            outAttrs.inputType &= ~EditorInfo.TYPE_TEXT_FLAG_NO_SUGGESTIONS;
            if ((outAttrs.inputType & EditorInfo.TYPE_MASK_CLASS) == EditorInfo.TYPE_CLASS_TEXT) {
                outAttrs.inputType |= EditorInfo.TYPE_TEXT_FLAG_AUTO_CORRECT;
                outAttrs.inputType |= EditorInfo.TYPE_TEXT_FLAG_AUTO_COMPLETE;
                outAttrs.inputType |= EditorInfo.TYPE_TEXT_FLAG_CAP_SENTENCES;
            }
            if (outAttrs.privateImeOptions != null) {
                outAttrs.privateImeOptions = outAttrs.privateImeOptions
                    .replace("nm", "")
                    .replace("noMicrophoneKey", "");
                if (outAttrs.privateImeOptions.trim().isEmpty()) {
                    outAttrs.privateImeOptions = null;
                }
            }
        }
        return ic;`
    );
    fs.writeFileSync(capacitorWebViewPath, content, 'utf8');
  }
}

const localPropertiesPath = path.join(root, 'android/local.properties');
if (fs.existsSync( path.join(root, 'android') )) {
  fs.writeFileSync(localPropertiesPath, 'sdk.dir=C\\:\\\\AndroidSdk\n', 'utf8');
}

