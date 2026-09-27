(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const loader = document.getElementById("loader");
  const fill = document.getElementById("loader-fill");
  let load = 0;
  const tick = () => {
    load = Math.min(100, load + (reduce ? 20 : 8 + Math.random() * 10));
    if (fill) fill.style.width = load + "%";
    if (load < 100) requestAnimationFrame(tick);
    else setTimeout(() => loader && loader.classList.add("done"), 280);
  };
  requestAnimationFrame(tick);

  const cursor = document.getElementById("cursor");
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  if (cursor && !reduce && window.matchMedia("(pointer:fine)").matches) {
    window.addEventListener("mousemove", (e) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    });
    const loopCursor = () => {
      mouse.tx += (mouse.x - mouse.tx) * 0.22;
      mouse.ty += (mouse.y - mouse.ty) * 0.22;
      cursor.style.transform = `translate3d(${mouse.tx}px, ${mouse.ty}px, 0)`;
      requestAnimationFrame(loopCursor);
    };
    loopCursor();
    document.querySelectorAll("[data-cursor='hover'], a, button").forEach((el) => {
      el.addEventListener("mouseenter", () => cursor.classList.add("on-hover"));
      el.addEventListener("mouseleave", () => cursor.classList.remove("on-hover"));
    });
  } else if (cursor) {
    cursor.style.display = "none";
    document.body.style.cursor = "auto";
  }

  const menuBtn = document.getElementById("menu-btn");
  const mobile = document.getElementById("mobile-nav");
  if (menuBtn && mobile) {
    menuBtn.addEventListener("click", () => mobile.classList.toggle("open"));
    mobile.querySelectorAll("a").forEach((a) =>
      a.addEventListener("click", () => mobile.classList.remove("open"))
    );
  }

  const reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            const delay = en.target.getAttribute("data-delay") || 0;
            en.target.style.animationDelay = delay + "ms";
            en.target.classList.add("in");
            io.unobserve(en.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add("in"));
  }

  if (reduce || typeof THREE === "undefined") return;

  const canvas = document.getElementById("webgl");
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x070807, 0.045);

  const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 80);
  camera.position.set(0, 0, 9);

  const group = new THREE.Group();
  scene.add(group);

  const icoGeo = new THREE.IcosahedronGeometry(2.35, 1);
  const ico = new THREE.LineSegments(
    new THREE.WireframeGeometry(icoGeo),
    new THREE.LineBasicMaterial({
      color: 0xc6ff1a,
      transparent: true,
      opacity: 0.22,
    })
  );
  group.add(ico);

  const inner = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.05, 0),
    new THREE.MeshBasicMaterial({
      color: 0xc6ff1a,
      wireframe: true,
      transparent: true,
      opacity: 0.35,
    })
  );
  group.add(inner);

  const COUNT = window.innerWidth < 700 ? 1400 : 2800;
  const positions = new Float32Array(COUNT * 3);
  const seeds = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    const r = 2.2 + Math.random() * 6.5;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi) * 0.7;
    seeds[i] = Math.random() * Math.PI * 2;
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const particles = new THREE.Points(
    pGeo,
    new THREE.PointsMaterial({
      color: 0xc6ff1a,
      size: 0.028,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      sizeAttenuation: true,
    })
  );
  scene.add(particles);

  const pointer = new THREE.Vector2(0, 0);
  window.addEventListener("pointermove", (e) => {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  });

  let scrollY = 0;
  window.addEventListener(
    "scroll",
    () => {
      scrollY = window.scrollY;
    },
    { passive: true }
  );

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const clock = new THREE.Clock();
  const base = pGeo.attributes.position.array;
  const orig = base.slice();

  const animate = () => {
    const t = clock.getElapsedTime();
    const doc = Math.min(scrollY / Math.max(document.body.scrollHeight - window.innerHeight, 1), 1);

    group.rotation.x = t * 0.07 + pointer.y * 0.18 + doc * 0.8;
    group.rotation.y = t * 0.11 + pointer.x * 0.28 + doc * 1.1;
    inner.rotation.y = -t * 0.22;
    inner.rotation.z = t * 0.08;
    const s = 1 + Math.sin(t * 0.6) * 0.04;
    ico.scale.setScalar(s);

    camera.position.x += (pointer.x * 0.6 - camera.position.x) * 0.04;
    camera.position.y += (pointer.y * 0.35 - camera.position.y) * 0.04;
    camera.lookAt(0, 0, 0);

    for (let i = 0; i < COUNT; i++) {
      const ix = i * 3;
      const swirl = Math.sin(t * 0.35 + seeds[i]) * 0.08;
      let x = orig[ix] + swirl;
      let y = orig[ix + 1] + Math.cos(t * 0.25 + seeds[i]) * 0.06;
      let z = orig[ix + 2];

      const dx = x - pointer.x * 4.2;
      const dy = y - pointer.y * 2.6;
      const d2 = dx * dx + dy * dy;
      if (d2 < 4.2) {
        const f = (4.2 - d2) * 0.18;
        x += dx * f;
        y += dy * f;
      }
      base[ix] = x;
      base[ix + 1] = y;
      base[ix + 2] = z;
    }
    pGeo.attributes.position.needsUpdate = true;
    particles.rotation.y = t * 0.02 + doc * 0.4;

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  };
  animate();
})();
