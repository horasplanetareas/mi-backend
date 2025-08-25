// server.js
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const mercadopago = require("mercadopago");

// ===== Config MercadoPago =====
mercadopago.configurations = { access_token: process.env.MP_ACCESS_TOKEN };

// ===== Firebase =====
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ===== Express setup =====
const app = express();
app.use(cors());

// Solo parsear JSON para rutas normales (no Stripe webhook)
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook-stripe") {
    next(); // no parsear body
  } else {
    express.json()(req, res, next);
  }
});

// =======================
// Stripe Checkout
// =======================
app.post("/stripe-checkout", async (req, res) => {
  try {
    const { priceId, email, uid } = req.body;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://horas-planetarias.vercel.app/success",
      cancel_url: "https://horas-planetarias.vercel.app/cancel",
      customer_email: email,
      metadata: { uid }, // 🔑 guardamos el uid en metadata
    });

    await db.collection("users").doc(uid).set(
      {
        stripeSessionId: session.id,
        subscriptionActive: false,
      },
      { merge: true }
    );

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error("Error Stripe:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =======================
// MercadoPago Checkout
// =======================
app.post("/mp-checkout", async (req, res) => {
  try {
    const { uid } = req.body;

    const preference = {
      items: [{ title: "Suscripción Mensual", unit_price: 300, quantity: 1 }],
      back_urls: {
        success: "https://horas-planetarias.vercel.app/success",
        failure: "https://horas-planetarias.vercel.app/failure",
        pending: "https://horas-planetarias.vercel.app/pending",
      },
      auto_return: "approved",
    };

    const response = await mercadopago.preferences.create(preference);

    await db.collection("users").doc(uid).set(
      {
        mpPreferenceId: response.body.id,
        subscriptionActive: false,
      },
      { merge: true }
    );

    res.json({ init_point: response.body.init_point });
  } catch (err) {
    console.error("Error MercadoPago:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =======================
// Webhook Stripe
// =======================
app.post(
  "/webhook-stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook Error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const uid = session.metadata.uid; // ✅ directo del checkout

      console.log("✅ Stripe checkout completado para uid:", uid);

      await db.collection("users").doc(uid).update({
        subscriptionActive: true,
        stripeCustomerId: session.customer,
        updatedAt: new Date(),
      });
    }

    res.json({ received: true });
  }
);

// =======================
// Webhook MercadoPago
// =======================
app.post("/webhook-mp", express.json(), async (req, res) => {
  const data = req.body;
  console.log("🔔 Webhook MP recibido:", data);

  if (data.type === "payment") {
    const preferenceId = data.data.preference_id;
    const userRef = db.collection("users").where("mpPreferenceId", "==", preferenceId);
    const snapshot = await userRef.get();
    snapshot.forEach((doc) =>
      doc.ref.update({ subscriptionActive: true, updatedAt: new Date() })
    );
  }

  res.json({ received: true });
});

// =======================
// Endpoint para verificar estado de suscripción
// =======================
app.get("/subscription-status/:uid", async (req, res) => {
  try {
    const uid = req.params.uid;
    const doc = await db.collection("users").doc(uid).get();
    if (!doc.exists) return res.status(404).json({ error: "Usuario no encontrado" });

    const data = doc.data();
    res.json({ subscriptionActive: data?.subscriptionActive || false });
  } catch (err) {
    console.error("Error al consultar suscripción:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
