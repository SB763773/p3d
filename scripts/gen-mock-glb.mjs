/**
 * 生成 mock provider 用的示例 GLB。
 *
 * 用程序化几何体在本地生成，不依赖任何外部下载 —— CI 和离线环境都能跑。
 * 输出到 public/mock/*.glb，mock provider 会把它们当作"生成结果"返回。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../public/mock');

// GLTFExporter 的二进制分支依赖 FileReader，Node 没有，补一个最小实现
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    constructor() {
      this.result = null;
      this.onloadend = null;
    }
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buffer) => {
        this.result = buffer;
        queueMicrotask(() => this.onloadend?.());
      });
    }
  };
}

function vaseGeometry() {
  const profile = [];
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // 花瓶轮廓：底部收，中部鼓，颈部细
    const r = 0.16 + 0.3 * Math.sin(Math.PI * (0.16 + t * 0.84)) * (1 - t * 0.42);
    profile.push(new THREE.Vector2(Math.max(0.04, r), t * 1.0));
  }
  return new THREE.LatheGeometry(profile, 72);
}

function knotGeometry() {
  return new THREE.TorusKnotGeometry(0.42, 0.13, 220, 32, 2, 3);
}

function rockGeometry() {
  const geometry = new THREE.IcosahedronGeometry(0.55, 4);
  const position = geometry.attributes.position;
  const vec = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    vec.fromBufferAttribute(position, i);
    // 用位置做确定性扰动，做出粗糙石头感
    const noise =
      1 +
      0.12 * Math.sin(vec.x * 9.1) * Math.cos(vec.y * 7.7) +
      0.06 * Math.sin(vec.z * 15.3 + vec.x * 4.2);
    vec.multiplyScalar(noise);
    position.setXYZ(i, vec.x, vec.y * 0.82, vec.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

const SHAPES = [
  {
    name: 'sample-vase.glb',
    geometry: vaseGeometry(),
    material: new THREE.MeshStandardMaterial({
      color: new THREE.Color('#cfd8e3'),
      roughness: 0.35,
      metalness: 0.05,
    }),
  },
  {
    name: 'sample-knot.glb',
    geometry: knotGeometry(),
    material: new THREE.MeshStandardMaterial({
      color: new THREE.Color('#d9a441'),
      roughness: 0.28,
      metalness: 0.75,
    }),
  },
  {
    name: 'sample-rock.glb',
    geometry: rockGeometry(),
    material: new THREE.MeshStandardMaterial({
      color: new THREE.Color('#8f8b85'),
      roughness: 0.92,
      metalness: 0.02,
      flatShading: true,
    }),
  },
];

const exporter = new GLTFExporter();

async function exportGlb(mesh) {
  const scene = new THREE.Scene();
  scene.add(mesh);
  const result = await exporter.parseAsync(scene, { binary: true, onlyVisible: true });
  return Buffer.from(result);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const shape of SHAPES) {
    shape.geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(shape.geometry, shape.material);
    mesh.name = shape.name.replace('.glb', '');
    const buffer = await exportGlb(mesh);
    writeFileSync(resolve(OUT_DIR, shape.name), buffer);
    console.log(`✓ ${shape.name}  ${(buffer.byteLength / 1024).toFixed(1)} KB`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
