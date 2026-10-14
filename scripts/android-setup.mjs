// بيجهّز مشروع الأندرويد بعد npx cap add android: الأذونات (ميكروفون/كاميرا) + رجوع الدخول الاجتماعي للتطبيق
import fs from 'node:fs';
const mf = 'android/app/src/main/AndroidManifest.xml';
let x = fs.readFileSync(mf, 'utf8');
const perms = ['android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS', 'android.permission.CAMERA', 'android.permission.READ_CONTACTS', 'android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION', 'android.permission.POST_NOTIFICATIONS', 'android.permission.VIBRATE'];
let add = '';
for (const p of perms) if (!x.includes(p)) add += `    <uses-permission android:name="${p}" />\n`;
if (!x.includes('android.hardware.camera')) add += '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n';
if (add) x = x.replace('</manifest>', add + '</manifest>');
// رابط ai.bods.app://auth علشان بعد ما تدخل بجوجل/فيسبوك/جيت هوب/X يرجعك للتطبيق
if (!x.includes('android:scheme="ai.bods.app"')) {
  const filter = '            <intent-filter>\n                <action android:name="android.intent.action.VIEW" />\n                <category android:name="android.intent.category.DEFAULT" />\n                <category android:name="android.intent.category.BROWSABLE" />\n                <data android:scheme="ai.bods.app" android:host="auth" />\n            </intent-filter>\n';
  x = x.replace('</activity>', filter + '        </activity>');
}
fs.writeFileSync(mf, x);
console.log('Manifest updated');
