const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const app = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(app, 'assets', 'launcher.svg'));
const ios = path.join(app, 'ios', 'Runner', 'Assets.xcassets', 'AppIcon.appiconset');
const contents = JSON.parse(fs.readFileSync(path.join(ios, 'Contents.json'), 'utf8'));
const android = path.join(app, 'android', 'app', 'src', 'main', 'res');

async function write(file, size) {
  await sharp(source).resize(size, size).png().toFile(file);
}

async function main() {
  for (const image of contents.images) {
    if (!image.filename) continue;
    const size = Math.round(Number(image.size.split('x')[0]) * Number(image.scale.replace('x', '')));
    await write(path.join(ios, image.filename), size);
  }
  for (const [density, size] of Object.entries({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 })) {
    await write(path.join(android, `mipmap-${density}`, 'ic_launcher.png'), size);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
