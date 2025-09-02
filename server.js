// server.js
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// ===== MercadoPago SDK v2 =====
const { MercadoPagoConfig, PreApproval } = require("mercadopago");
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const preapproval = new PreApproval(mpClient);

// ===== Firebase =====
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ===== Express =====
const app = express();
app.use(cors());

// ⚠️ Importante: el JSON parser se aplica a todo MENOS al webhook de Stripe
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook-stripe") {
    next(); // dejamos que use express.raw()
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
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "subscription",
      customer_email: email,
      metadata: { uid },
      success_url: "https://horas-planetarias.vercel.app/success",
      cancel_url: "https://horas-planetarias.vercel.app/cancel",
    });

    await db.collection("users").doc(uid).set(
      { stripeSessionId: session.id, subscriptionActive: false },
      { merge: true }
    );

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error("Error Stripe Checkout:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =======================
// Stripe Webhook
// =======================
app.post(
  "/webhook-stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Stripe Webhook Error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const uid = session.metadata?.uid;
      if (uid) {
        await db.collection("users").doc(uid).update({
          subscriptionActive: true,
          stripeCustomerId: session.customer,
          updatedAt: new Date(),
        });
        console.log("✅ Stripe subscription activada:", uid);
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const subscriptionId = subscription.id;

      if (subscriptionId) {
        const snapshot = await db.collection("users")
          .where("subscriptionId", "==", subscriptionId)
          .get();

        snapshot.forEach((doc) =>
          doc.ref.update({
            subscriptionActive: false,
            updatedAt: new Date(),
          })
        );

        console.log("❌ Stripe subscription cancelada:", subscriptionId);
      }
    }

    res.json({ received: true });
  }
);

// =======================
// MercadoPago Suscripción
// =======================
app.post("/mp-subscription", async (req, res) => {
  try {
    const { uid, email } = req.body;

    const response = await preapproval.create({
      body: {
        reason: "Suscripción Mensual - Plan Premium",
        auto_recurring: {
          frequency: 1,
          frequency_type: "months",
          transaction_amount: 300,
          currency_id: "UYU",
          start_date: new Date().toISOString(),
          end_date: new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toISOString(),
        },
        back_url: "https://horas-planetarias.vercel.app/success",
        payer_email: email,
      },
    });

    await db.collection("users").doc(uid).set(
      { mpPreapprovalId: response.id, subscriptionActive: false },
      { merge: true }
    );

    res.json({ init_point: response.init_point });
  } catch (err) {
    console.error("Error MercadoPago Suscripción:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =======================
// MercadoPago Webhook
// =======================
app.post("/webhook-mp", async (req, res) => {
  const data = req.body;
  console.log("🔔 Webhook MP recibido:", JSON.stringify(data, null, 2));

  if (data.type === "preapproval") {
    const preapprovalId = data.data?.id;
    const status = data.data?.status; // approved / cancelled

    if (preapprovalId) {
      const userRef = db.collection("users").where("mpPreapprovalId", "==", preapprovalId);
      const snapshot = await userRef.get();

      snapshot.forEach((doc) =>
        doc.ref.update({
          subscriptionActive: status === "authorized",
          updatedAt: new Date(),
        })
      );

      console.log(
        `✅ MercadoPago subscription ${status === "authorized" ? "activada" : "cancelada"}:`,
        preapprovalId
      );
    }
  }

  res.json({ received: true });
});

// =======================
// Estado de suscripción
// =======================
app.get("/subscription-status/:uid", async (req, res) => {
  try {
    const { uid } = req.params;
    const userDoc = await db.collection("users").doc(uid).get();

    if (!userDoc.exists) return res.json({ subscriptionActive: false });

    const userData = userDoc.data();
    res.json({ subscriptionActive: userData.subscriptionActive || false });
  } catch (err) {
    console.error("Error Subscription Status:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =======================
// Start Server
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
