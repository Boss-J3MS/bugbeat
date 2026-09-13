# ═══════════════════════════════════════════════
#  CODEBEAT — train.py
#  Trains the Random Forest + Neural Network
#  ensemble on the NASA/PROMISE defect datasets.
#
#  Usage:
#    python train.py --data path/to/dataset.csv
#
#  Expected CSV columns:
#    loc, cc, wmc, rfc, cbo, ... , defective (0/1)
# ═══════════════════════════════════════════════

import os
import argparse
import numpy as np
import joblib
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, roc_auc_score

from model import CodeComplexityNet, FEATURE_KEYS, INPUT_DIM, MODEL_DIR

RF_PATH = os.path.join(MODEL_DIR, "random_forest.pkl")
NN_PATH = os.path.join(MODEL_DIR, "neural_net.pth")

# ── Synthetic data generator ───────────────────
# Used when no real dataset is provided.
# Replace with NASA/PROMISE CSV for real training.
def generate_synthetic_data(n_samples: int = 2000):
    """
    Generates synthetic training data based on known
    complexity thresholds from software engineering research.
    """
    np.random.seed(42)
    X, y = [], []

    for _ in range(n_samples):
        # Simulate clean code
        if np.random.random() < 0.6:
            features = {
                'loc': np.random.randint(5, 50),
                'lloc': np.random.randint(3, 40),
                'sloc': np.random.randint(3, 35),
                'comments': np.random.randint(0, 10),
                'comment_ratio': np.random.uniform(0, 0.3),
                'num_functions': np.random.randint(1, 5),
                'cc_total': np.random.randint(1, 8),
                'cc_max': np.random.randint(1, 4),
                'cc_avg': np.random.uniform(1, 3),
                'cc_high_count': 0,
                'h_volume': np.random.uniform(10, 200),
                'h_difficulty': np.random.uniform(1, 10),
                'h_effort': np.random.uniform(100, 2000),
                'h_bugs': np.random.uniform(0, 0.3),
                'maintainability': np.random.uniform(60, 100),
                'max_indent_depth': np.random.randint(1, 3),
                'nested_blocks': np.random.randint(1, 3),
                'num_loops': np.random.randint(0, 3),
                'num_conditions': np.random.randint(1, 5),
                'num_try_catch': np.random.randint(0, 2),
                'num_returns': np.random.randint(1, 4),
                'num_classes': np.random.randint(0, 2),
                'num_imports': np.random.randint(0, 5),
                'max_line_length': np.random.randint(20, 60),
                'avg_line_length': np.random.uniform(15, 40),
            }
            label = 0  # non-defective
        else:
            # Simulate complex/defective code
            features = {
                'loc': np.random.randint(50, 500),
                'lloc': np.random.randint(40, 400),
                'sloc': np.random.randint(35, 380),
                'comments': np.random.randint(0, 5),
                'comment_ratio': np.random.uniform(0, 0.1),
                'num_functions': np.random.randint(5, 20),
                'cc_total': np.random.randint(10, 80),
                'cc_max': np.random.randint(5, 25),
                'cc_avg': np.random.uniform(3, 12),
                'cc_high_count': np.random.randint(1, 10),
                'h_volume': np.random.uniform(500, 5000),
                'h_difficulty': np.random.uniform(15, 60),
                'h_effort': np.random.uniform(5000, 50000),
                'h_bugs': np.random.uniform(0.5, 3.0),
                'maintainability': np.random.uniform(10, 50),
                'max_indent_depth': np.random.randint(4, 10),
                'nested_blocks': np.random.randint(4, 12),
                'num_loops': np.random.randint(3, 15),
                'num_conditions': np.random.randint(5, 30),
                'num_try_catch': np.random.randint(0, 5),
                'num_returns': np.random.randint(3, 15),
                'num_classes': np.random.randint(1, 5),
                'num_imports': np.random.randint(5, 20),
                'max_line_length': np.random.randint(80, 200),
                'avg_line_length': np.random.uniform(40, 100),
            }
            label = 1  # defective

        X.append([features[k] for k in FEATURE_KEYS])
        y.append(label)

    return np.array(X, dtype=np.float32), np.array(y, dtype=np.float32)


def load_csv_data(path: str):
    """Load real NASA/PROMISE dataset CSV."""
    import csv
    X, y = [], []
    with open(path, 'r') as f:
        reader = csv.DictReader(f)

        print("CSV columns:")
        print(reader.fieldnames)

        for row in reader:
            try:
                features = [float(row.get(k, 0) or 0) for k in FEATURE_KEYS]
                label = 1 if str(row.get('defect', '0')).lower() in ('1','true','yes') else 0
                X.append(features)
                y.append(label)
            except Exception:
                continue
    return np.array(X, dtype=np.float32), np.array(y, dtype=np.float32)


def train(data_path: str = None, epochs: int = 50, batch_size: int = 64):
    print('═' * 50)
    print('  CODEBEAT ML — Training')
    print('═' * 50)

    # Load data
    if data_path and os.path.exists(data_path):
        print(f'Loading dataset: {data_path}')
        X, y = load_csv_data(data_path)
    else:
        print('No dataset provided — using synthetic data.')
        print('For better accuracy, provide a NASA/PROMISE CSV.')
        X, y = generate_synthetic_data(2000)

    print(f'Dataset: {len(X)} samples, {X.shape[1]} features')
    print(f'Class distribution: {int(y.sum())} defective / {int((1-y).sum())} clean')

    # Split
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    # Scale
    scaler = StandardScaler()
    X_train_s = scaler.fit_transform(X_train)
    X_test_s  = scaler.transform(X_test)

    os.makedirs(MODEL_DIR, exist_ok=True)
    joblib.dump(scaler, os.path.join(MODEL_DIR, 'scaler.pkl'))
    print('✓ Scaler saved')

    # ── Train Random Forest ────────────────────
    print('\nTraining Random Forest...')
    rf = RandomForestClassifier(
        n_estimators=200, max_depth=12,
        min_samples_split=5, min_samples_leaf=2,
        class_weight='balanced', random_state=42, n_jobs=-1
    )

    rf.fit(X_train_s, y_train)
    rf_preds = rf.predict(X_test_s)
    rf_probs = rf.predict_proba(X_test_s)[:, 1]
    print(f'RF AUC: {roc_auc_score(y_test, rf_probs):.4f}')
    print(classification_report(y_test, rf_preds, target_names=['Clean','Defective']))
    joblib.dump(rf, RF_PATH)
    print('✓ Random Forest saved')

    # ── Train Neural Network ───────────────────
    print('\nTraining Neural Network...')
    net = CodeComplexityNet(INPUT_DIM)
    optimizer = torch.optim.Adam(net.parameters(), lr=1e-3, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs)
    criterion = nn.BCELoss()

    # Class weights for imbalanced data
    pos_weight = torch.tensor([(1 - y_train.mean()) / max(y_train.mean(), 1e-6)])
    criterion  = nn.BCEWithLogitsLoss(pos_weight=pos_weight)

    X_t = torch.FloatTensor(X_train_s)
    y_t = torch.FloatTensor(y_train).unsqueeze(1)
    dataset = TensorDataset(X_t, y_t)
    loader  = DataLoader(dataset, batch_size=batch_size, shuffle=True)

    net.train()
    for epoch in range(epochs):
        total_loss = 0
        for xb, yb in loader:
            optimizer.zero_grad()
            out  = net(xb)
            loss = criterion(out, yb)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
        scheduler.step()
        if (epoch + 1) % 10 == 0:
            print(f'  Epoch {epoch+1}/{epochs} — Loss: {total_loss/len(loader):.4f}')

    # Evaluate NN
    net.eval()
    with torch.no_grad():
        X_test_t  = torch.FloatTensor(X_test_s)
        nn_probs  = torch.sigmoid(net(X_test_t)).squeeze().numpy()
        nn_preds  = (nn_probs > 0.5).astype(int)
    print(f'NN AUC: {roc_auc_score(y_test, nn_probs):.4f}')
    print(classification_report(y_test, nn_preds, target_names=['Clean','Defective']))
    torch.save(net.state_dict(), NN_PATH)
    print('✓ Neural Network saved')

    # ── Ensemble evaluation ────────────────────
    ensemble_probs = 0.4 * rf_probs + 0.6 * nn_probs
    ensemble_preds = (ensemble_probs > 0.5).astype(int)
    print(f'\nEnsemble AUC: {roc_auc_score(y_test, ensemble_probs):.4f}')
    print(classification_report(y_test, ensemble_preds, target_names=['Clean','Defective']))

    print('\n✅ Training complete! Models saved to ml-service/models/')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Train Codebeat ML models')
    parser.add_argument('--data',   type=str, default=None, help='Path to NASA/PROMISE CSV dataset')
    parser.add_argument('--epochs', type=int, default=50,   help='Training epochs for NN')
    parser.add_argument('--batch',  type=int, default=64,   help='Batch size for NN')
    args = parser.parse_args()
    train(args.data, args.epochs, args.batch)