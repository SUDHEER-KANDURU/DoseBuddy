const API_BASE = "https://dosebuddy.sudheerkanduru-5588.workers.dev/api";

async function measureRequest(url, options = {}) {
    const startTime = performance.now();
    try {
        const response = await fetch(url, options);
        const endTime = performance.now();
        const duration = endTime - startTime;
        console.log(`${options.method || 'GET'} ${url}: ${duration.toFixed(2)}ms (${response.status})`);
        return { duration, status: response.status, ok: response.ok };
    } catch (error) {
        const endTime = performance.now();
        const duration = endTime - startTime;
        console.log(`${options.method || 'GET'} ${url}: ${duration.toFixed(2)}ms (ERROR: ${error.message})`);
        return { duration, error: error.message };
    }
}

// Test health endpoint first
async function testEndpoints() {
    console.log("Testing API endpoints...");
    
    // Test basic connectivity
    await measureRequest(`${API_BASE}/health`);
    
    // Test auth endpoint (should fail quickly with 401)
    await measureRequest(`${API_BASE}/medications/list/1`, {
        method: 'GET',
        headers: { 'Authorization': 'Bearer invalid-token' }
    });
    
    // Test add medicine endpoint (should fail quickly with 401)
    await measureRequest(`${API_BASE}/medications/add`, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': 'Bearer invalid-token'
        },
        body: JSON.stringify({
            userId: 1,
            name: "Test Med",
            dosage: "1 tablet",
            instructions: "Test",
            startDate: "2024-01-01",
            endDate: "2024-01-31",
            times: ["08:00"]
        })
    });
    
    // Test mark taken endpoint (should fail quickly with 401)
    await measureRequest(`${API_BASE}/logs/mark`, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': 'Bearer invalid-token'
        },
        body: JSON.stringify({
            userId: 1,
            medicationId: 1,
            status: "TAKEN",
            date: "2024-01-01",
            time: "08:00"
        })
    });
}

testEndpoints();