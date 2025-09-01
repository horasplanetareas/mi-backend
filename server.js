// server.js
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const mercadopago = require("mercadopago");

// ===== Config MercadoPago =====
mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN,
});

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
// Stripe Checkout (queda igual)
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
      metadata: { uid },
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
// MercadoPago Suscripción Mensual
// =======================
app.post("/mp-subscription", async (req, res) => {
  try {
    const { uid, email } = req.body;

    const subscription = {
      reason: "Suscripción Mensual - Plan Premium",
      auto_recurring: {
        frequency: 1,
        frequency_type: "months",
        transaction_amount: 300, // 💰 monto mensual
        currency_id: "UYU",      // pesos uruguayos
        start_date: new Date().toISOString(),
        end_date: new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toISOString()
      },
      back_url: "https://horas-planetarias.vercel.app/success",
      payer_email: email
    };

    const response = await mercadopago.preapproval.create(subscription);

    // Guardar en Firebase
    await db.collection("users").doc(uid).set(
      {
        mpPreapprovalId: response.body.id,
        subscriptionActive: false,
      },
      { merge: true }
    );

    res.json({ init_point: response.body.init_point });
  } catch (err) {
    console.error("Error MercadoPago Suscripción:", err.message);
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
      const uid = session.metadata.uid;

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
// Webhook MercadoPago Suscripciones
// =======================
app.post("/webhook-mp", express.json(), async (req, res) => {
  const data = req.body;
  console.log("🔔 Webhook MP recibido:", JSON.stringify(data, null, 2));

  if (data.type === "preapproval") {
    const preapprovalId = data.data.id;

    const userRef = db.collection("users").where("mpPreapprovalId", "==", preapprovalId);
    const snapshot = await userRef.get();

    snapshot.forEach((doc) =>
      doc.ref.update({
        subscriptionActive: true,
        updatedAt: new Date(),
      })
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
