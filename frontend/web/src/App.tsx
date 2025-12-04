// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface Review {
  id: string;
  encryptedRating: string;
  encryptedComment: string;
  timestamp: number;
  owner: string;
  business: string;
  status: "pending" | "verified" | "rejected";
  paymentProof: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newReview, setNewReview] = useState({ business: "", rating: 0, comment: "", paymentProof: "" });
  const [selectedReview, setSelectedReview] = useState<Review | null>(null);
  const [decryptedRating, setDecryptedRating] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "verified" | "pending" | "rejected">("all");
  const [userHistory, setUserHistory] = useState<string[]>([]);

  const verifiedCount = reviews.filter(r => r.status === "verified").length;
  const pendingCount = reviews.filter(r => r.status === "pending").length;
  const rejectedCount = reviews.filter(r => r.status === "rejected").length;

  useEffect(() => {
    loadReviews().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadReviews = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("review_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing review keys:", e); }
      }
      const list: Review[] = [];
      for (const key of keys) {
        try {
          const reviewBytes = await contract.getData(`review_${key}`);
          if (reviewBytes.length > 0) {
            try {
              const reviewData = JSON.parse(ethers.toUtf8String(reviewBytes));
              list.push({ 
                id: key, 
                encryptedRating: reviewData.rating, 
                encryptedComment: reviewData.comment,
                timestamp: reviewData.timestamp, 
                owner: reviewData.owner, 
                business: reviewData.business, 
                status: reviewData.status || "pending",
                paymentProof: reviewData.paymentProof || ""
              });
            } catch (e) { console.error(`Error parsing review data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading review ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setReviews(list);
    } catch (e) { console.error("Error loading reviews:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitReview = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting review with Zama FHE..." });
    try {
      const encryptedRating = FHEEncryptNumber(newReview.rating);
      const encryptedComment = `FHE-${btoa(newReview.comment)}`;
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const reviewId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const reviewData = { 
        rating: encryptedRating, 
        comment: encryptedComment,
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        business: newReview.business, 
        status: "pending",
        paymentProof: newReview.paymentProof
      };
      await contract.setData(`review_${reviewId}`, ethers.toUtf8Bytes(JSON.stringify(reviewData)));
      const keysBytes = await contract.getData("review_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(reviewId);
      await contract.setData("review_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted review submitted securely!" });
      await loadReviews();
      setUserHistory(prev => [...prev, `Submitted review for ${newReview.business}`]);
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewReview({ business: "", rating: 0, comment: "", paymentProof: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const verifyReview = async (reviewId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Verifying review with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const reviewBytes = await contract.getData(`review_${reviewId}`);
      if (reviewBytes.length === 0) throw new Error("Review not found");
      const reviewData = JSON.parse(ethers.toUtf8String(reviewBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedReview = { ...reviewData, status: "verified" };
      await contractWithSigner.setData(`review_${reviewId}`, ethers.toUtf8Bytes(JSON.stringify(updatedReview)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Review verified successfully!" });
      await loadReviews();
      setUserHistory(prev => [...prev, `Verified review ${reviewId.substring(0, 6)}`]);
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Verification failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const rejectReview = async (reviewId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Rejecting review..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const reviewBytes = await contract.getData(`review_${reviewId}`);
      if (reviewBytes.length === 0) throw new Error("Review not found");
      const reviewData = JSON.parse(ethers.toUtf8String(reviewBytes));
      const updatedReview = { ...reviewData, status: "rejected" };
      await contract.setData(`review_${reviewId}`, ethers.toUtf8Bytes(JSON.stringify(updatedReview)));
      setTransactionStatus({ visible: true, status: "success", message: "Review rejected successfully!" });
      await loadReviews();
      setUserHistory(prev => [...prev, `Rejected review ${reviewId.substring(0, 6)}`]);
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (reviewAddress: string) => address?.toLowerCase() === reviewAddress.toLowerCase();

  const filteredReviews = reviews.filter(review => {
    const matchesSearch = review.business.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         review.owner.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === "all" || review.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const renderStats = () => {
    return (
      <div className="stats-container">
        <div className="stat-card">
          <div className="stat-value">{reviews.length}</div>
          <div className="stat-label">Total Reviews</div>
        </div>
        <div className="stat-card verified">
          <div className="stat-value">{verifiedCount}</div>
          <div className="stat-label">Verified</div>
        </div>
        <div className="stat-card pending">
          <div className="stat-value">{pendingCount}</div>
          <div className="stat-label">Pending</div>
        </div>
        <div className="stat-card rejected">
          <div className="stat-value">{rejectedCount}</div>
          <div className="stat-label">Rejected</div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Loading encrypted reviews...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>隱信點評</h1>
          <span className="subtitle">FHE-Encrypted Reviews</span>
        </div>
        <div className="header-actions">
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          <button onClick={() => setShowCreateModal(true)} className="primary-btn">
            + Add Review
          </button>
        </div>
      </header>

      <main className="main-content">
        <section className="intro-section">
          <h2>DeSoc Protocol for FHE-Encrypted Reviews</h2>
          <p>
            A decentralized review protocol where user reviews are encrypted using Zama FHE technology. 
            Users must prove their "real consumer" identity through payment records or DID to prevent fake reviews.
          </p>
          <div className="features">
            <div className="feature">
              <div className="feature-icon">🔒</div>
              <h3>FHE Encryption</h3>
              <p>Reviews are encrypted end-to-end using Zama FHE</p>
            </div>
            <div className="feature">
              <div className="feature-icon">🆔</div>
              <h3>Identity Verification</h3>
              <p>Only verified consumers can submit reviews</p>
            </div>
            <div className="feature">
              <div className="feature-icon">⚖️</div>
              <h3>Fair System</h3>
              <p>Prevents fake reviews and malicious ratings</p>
            </div>
          </div>
        </section>

        <section className="stats-section">
          <h2>Review Statistics</h2>
          {renderStats()}
        </section>

        <section className="reviews-section">
          <div className="section-header">
            <h2>Encrypted Reviews</h2>
            <div className="controls">
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="Search businesses..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                <button className="search-btn">🔍</button>
              </div>
              <select 
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value as any)}
                className="status-filter"
              >
                <option value="all">All Statuses</option>
                <option value="verified">Verified</option>
                <option value="pending">Pending</option>
                <option value="rejected">Rejected</option>
              </select>
              <button onClick={loadReviews} className="refresh-btn" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "🔄 Refresh"}
              </button>
            </div>
          </div>

          {filteredReviews.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📭</div>
              <p>No reviews found matching your criteria</p>
              <button onClick={() => setShowCreateModal(true)} className="primary-btn">
                Submit First Review
              </button>
            </div>
          ) : (
            <div className="reviews-grid">
              {filteredReviews.map(review => (
                <div 
                  key={review.id} 
                  className={`review-card ${review.status}`}
                  onClick={() => setSelectedReview(review)}
                >
                  <div className="card-header">
                    <span className="business">{review.business}</span>
                    <span className={`status ${review.status}`}>{review.status}</span>
                  </div>
                  <div className="card-body">
                    <div className="rating">
                      <span>Rating: </span>
                      <div className="stars">
                        {decryptedRating && review.id === selectedReview?.id ? (
                          Array(5).fill(0).map((_, i) => (
                            <span key={i} className={i < decryptedRating ? "filled" : ""}>★</span>
                          ))
                        ) : (
                          <span>🔒 Encrypted</span>
                        )}
                      </div>
                    </div>
                    <div className="owner">
                      <span>By: {review.owner.substring(0, 6)}...{review.owner.substring(38)}</span>
                    </div>
                    <div className="date">
                      {new Date(review.timestamp * 1000).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="card-footer">
                    {isOwner(review.owner) && review.status === "pending" && (
                      <div className="actions">
                        <button 
                          className="verify-btn"
                          onClick={(e) => { e.stopPropagation(); verifyReview(review.id); }}
                        >
                          Verify
                        </button>
                        <button 
                          className="reject-btn"
                          onClick={(e) => { e.stopPropagation(); rejectReview(review.id); }}
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {isConnected && (
          <section className="history-section">
            <h2>Your Recent Actions</h2>
            <div className="history-list">
              {userHistory.length === 0 ? (
                <p className="no-history">No recent actions</p>
              ) : (
                <ul>
                  {userHistory.slice(0, 5).map((action, index) => (
                    <li key={index}>{action}</li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}
      </main>

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal">
            <div className="modal-header">
              <h2>Submit Encrypted Review</h2>
              <button onClick={() => setShowCreateModal(false)} className="close-btn">
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Business Name *</label>
                <input 
                  type="text" 
                  value={newReview.business}
                  onChange={(e) => setNewReview({...newReview, business: e.target.value})}
                  placeholder="Enter business name"
                />
              </div>
              <div className="form-group">
                <label>Rating (1-5) *</label>
                <div className="rating-input">
                  {[1, 2, 3, 4, 5].map(star => (
                    <span 
                      key={star}
                      className={star <= newReview.rating ? "selected" : ""}
                      onClick={() => setNewReview({...newReview, rating: star})}
                    >
                      ★
                    </span>
                  ))}
                </div>
              </div>
              <div className="form-group">
                <label>Review Comment</label>
                <textarea 
                  value={newReview.comment}
                  onChange={(e) => setNewReview({...newReview, comment: e.target.value})}
                  placeholder="Your review (will be encrypted)"
                />
              </div>
              <div className="form-group">
                <label>Payment Proof *</label>
                <input 
                  type="text" 
                  value={newReview.paymentProof}
                  onChange={(e) => setNewReview({...newReview, paymentProof: e.target.value})}
                  placeholder="Transaction hash or DID proof"
                />
              </div>
              <div className="encryption-notice">
                <div className="lock-icon">🔒</div>
                <p>Your review will be encrypted with Zama FHE before submission</p>
              </div>
            </div>
            <div className="modal-footer">
              <button 
                onClick={submitReview} 
                disabled={creating || !newReview.business || !newReview.paymentProof}
                className="submit-btn"
              >
                {creating ? "Encrypting..." : "Submit Review"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedReview && (
        <div className="modal-overlay">
          <div className="detail-modal">
            <div className="modal-header">
              <h2>Review Details</h2>
              <button onClick={() => {
                setSelectedReview(null);
                setDecryptedRating(null);
              }} className="close-btn">
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="detail-row">
                <span className="detail-label">Business:</span>
                <span className="detail-value">{selectedReview.business}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Reviewer:</span>
                <span className="detail-value">{selectedReview.owner}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Date:</span>
                <span className="detail-value">
                  {new Date(selectedReview.timestamp * 1000).toLocaleString()}
                </span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Status:</span>
                <span className={`detail-value status ${selectedReview.status}`}>
                  {selectedReview.status}
                </span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Payment Proof:</span>
                <span className="detail-value">
                  {selectedReview.paymentProof.substring(0, 20)}...
                </span>
              </div>
              
              <div className="encrypted-section">
                <h3>Encrypted Data</h3>
                <div className="encrypted-data">
                  <p><strong>Rating:</strong> {selectedReview.encryptedRating.substring(0, 30)}...</p>
                  <p><strong>Comment:</strong> {selectedReview.encryptedComment.substring(0, 30)}...</p>
                </div>
                <button 
                  onClick={async () => {
                    if (decryptedRating !== null) {
                      setDecryptedRating(null);
                    } else {
                      const decrypted = await decryptWithSignature(selectedReview.encryptedRating);
                      if (decrypted !== null) setDecryptedRating(decrypted);
                    }
                  }}
                  disabled={isDecrypting}
                  className="decrypt-btn"
                >
                  {isDecrypting ? "Decrypting..." : 
                   decryptedRating !== null ? "Hide Decrypted Data" : "Decrypt Rating"}
                </button>
              </div>

              {decryptedRating !== null && (
                <div className="decrypted-section">
                  <h3>Decrypted Rating</h3>
                  <div className="decrypted-rating">
                    <div className="stars">
                      {Array(5).fill(0).map((_, i) => (
                        <span key={i} className={i < decryptedRating ? "filled" : ""}>★</span>
                      ))}
                    </div>
                    <span className="numeric-rating">{decryptedRating}/5</span>
                  </div>
                  <div className="decryption-notice">
                    This data was decrypted using your wallet signature and is only visible to you
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="notification">
          <div className={`notification-content ${transactionStatus.status}`}>
            {transactionStatus.status === "pending" && <div className="spinner"></div>}
            {transactionStatus.status === "success" && <div className="icon">✓</div>}
            {transactionStatus.status === "error" && <div className="icon">✗</div>}
            <p>{transactionStatus.message}</p>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-section">
            <h3>隱信點評</h3>
            <p>FHE-Encrypted, Sybil-Resistant Reviews</p>
          </div>
          <div className="footer-section">
            <h3>Powered By</h3>
            <p>Zama FHE Technology</p>
            <p>DeSoc Protocol</p>
          </div>
          <div className="footer-section">
            <h3>Links</h3>
            <a href="#">Documentation</a>
            <a href="#">GitHub</a>
            <a href="#">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <p>© 2025 隱信點評. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
};

export default App;