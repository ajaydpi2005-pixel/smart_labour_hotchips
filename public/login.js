const loginForm = document.getElementById('loginForm');
const shopSelect = document.getElementById('shopSelect');
const passwordInput = document.getElementById('passwordInput');
const message = document.getElementById('message');

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const shopName = shopSelect.value;
    const password = passwordInput.value;
    
    if (!shopName || !password) {
        showMessage('Please fill all fields', 'error');
        return;
    }
    
    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ shopName, password })
        });
        
        const data = await response.json();
        
        if (response.ok && data.success) {
            // Store token in localStorage
            localStorage.setItem('authToken', data.token);
            localStorage.setItem('shopName', data.shopName);
            localStorage.setItem('shopId', data.shopId);
            
            showMessage('Login successful! Redirecting...', 'success');
            
            // Redirect to billing page
            setTimeout(() => {
                window.location.href = '/index.html';
            }, 1000);
        } else {
            showMessage('Invalid shop name or password', 'error');
        }
    } catch (error) {
        console.error('Login error:', error);
        showMessage('Login failed. Please try again.', 'error');
    }
});

function showMessage(text, type) {
    message.textContent = text;
    message.className = 'message';
    if (type) {
        message.classList.add(type);
    }
}
